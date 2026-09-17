import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import type { AddOrEditTokenInput, TxPayloadBatchSequence, Vault } from "@symmetry-hq/sdk";
import { VaultLayout } from "@symmetry-hq/sdk/dist/layouts/basket.js";
import { OracleAggregatorLayout } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import { IntentLayout, IntentStatus, TaskType } from "@symmetry-hq/sdk/dist/layouts/intents/intent.js";
import { sha256 } from "./amounts.ts";
import { assertInstalledComposition, assertInstalledToken, NATIVE_DEFAULT_BINDINGS } from "./native-defaults.ts";
import { SYMMETRY_PROGRAM_ID, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import type { KakuSanPreparedTx } from "./kaku-san-create.ts";

const CREATE_EDIT = Buffer.from([82, 150, 58, 227, 153, 129, 20, 30]);
const EXECUTE_EDIT = Buffer.from([156, 31, 4, 39, 248, 29, 55, 220]);
export interface CompositionRequest {
  vault: string; shareMint: string; creator: string;
  token?: AddOrEditTokenInput;
  legs: readonly { mint: string; targetWeightBps: number; token: AddOrEditTokenInput }[];
}

/** ONLY the pinned SDK's zero-delay configuration pair. Do not flatten dependent transactions
 * and simulate them independently (execute then sees no intent, 3012). No split fallback that
 * could charge/open an unexecutable intent; oversized or delayed configurations fail closed. */
export async function atomicCompositionTransaction(native: NativeVaultBuilders, payload: TxPayloadBatchSequence, creator: string, resume = false): Promise<KakuSanPreparedTx & { intent: string }> {
  const transactions = payload.batches.flatMap(b => b.transactions);
  if (transactions.length !== (resume ? 1 : 2)) throw new Error("COMPOSITION_DELAY_OR_SHAPE: expected an immediate create-intent/execute pair; no transaction released");
  const tables = new Map<string, AddressLookupTableAccount>();
  const instructions: TransactionInstruction[] = [];
  let blockhash = "";
  for (const item of transactions) {
    const tx = VersionedTransaction.deserialize(Buffer.from(item.tx_b64, "base64"));
    if (item.payer !== creator || tx.message.staticAccountKeys[0]?.toBase58() !== creator || tx.message.header.numRequiredSignatures !== 1 || tx.signatures.some(s => s.some(b => b !== 0))) throw new Error("COMPOSITION_SIGNER: unsigned deployer-only payload required");
    blockhash ||= tx.message.recentBlockhash;
    for (const lookup of tx.message.addressTableLookups) {
      const key = lookup.accountKey.toBase58();
      if (!tables.has(key)) {
        const table = await native.connection.getAddressLookupTable(lookup.accountKey);
        if (!table.value) throw new Error("COMPOSITION_LUT: lookup table unavailable");
        tables.set(key, table.value);
      }
    }
    instructions.push(...TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [...tables.values()] }).instructions);
  }
  const nativeIxs = instructions.filter(i => i.programId.toBase58() === SYMMETRY_PROGRAM_ID);
  const expected = resume ? [EXECUTE_EDIT] : [CREATE_EDIT, EXECUTE_EDIT];
  if (nativeIxs.length !== expected.length || nativeIxs.some((ix, i) => !ix.data.subarray(0, 8).equals(expected[i]))) throw new Error("COMPOSITION_INSTRUCTIONS: unexpected native instruction");
  if (!resume && ![TaskType.AddToken, TaskType.UpdateWeights].includes(nativeIxs[0].data[40])) throw new Error("COMPOSITION_TASK: only token/weight edits are permitted");
  if (!resume && !nativeIxs[0].keys[2].pubkey.equals(nativeIxs[1].keys[2].pubkey)) throw new Error("COMPOSITION_INTENT: dependent intent mismatch");
  // Identical duplicate compute-budget instructions are illegal in one transaction. Preserve
  // the SDK's amounts/priority price; refuse conflicts instead of silently changing economics.
  const budget = new Map<number, Buffer>();
  const unique = instructions.filter(ix => {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) return true;
    const previous = budget.get(ix.data[0]);
    if (previous && !previous.equals(ix.data)) throw new Error("COMPOSITION_BUDGET: conflicting compute budget");
    budget.set(ix.data[0], ix.data);
    return !previous;
  });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(creator), recentBlockhash: blockhash, instructions: unique }).compileToV0Message([...tables.values()]));
  let bytes: Uint8Array;
  try { bytes = tx.serialize(); } catch { throw new Error("COMPOSITION_PACKET_TOO_LARGE: refusing to split a dependent edit"); }
  if (bytes.length > 1232) throw new Error("COMPOSITION_PACKET_TOO_LARGE: refusing to split a dependent edit");
  return { txBase64: Buffer.from(bytes).toString("base64"), payer: creator, messageHash: sha256(tx.message.serialize()), intent: nativeIxs.at(-1)!.keys[2].pubkey.toBase58() };
}

/** Native immediate intents are status NotActive (0), with activeManagements still zero.
 * Neither field is a sufficient pending-intent check: read the program-owned intent accounts. */
export async function pendingCompositionIntents(native: NativeVaultBuilders, vault: string) {
  return (await native.sdk.fetchVaultIntents(vault)).filter(i => i.status !== IntentStatus.Reverted && i.status !== IntentStatus.Completed);
}
export function compositionResumeStep(pending: Awaited<ReturnType<typeof pendingCompositionIntents>>, legMints: readonly string[]) {
  if (!pending.length) return undefined;
  if (pending.length !== 1) throw new Error("RECOVERY_REQUIRED: multiple pending configuration intents; inspect without cancelling");
  const intent = pending[0];
  if (intent.taskType === TaskType.UpdateWeights) return { step: "weights" as const };
  if (intent.taskType !== TaskType.AddToken) throw new Error("RECOVERY_REQUIRED: non-composition native intent; inspect before resuming");
  const mint = new PublicKey(intent.taskData.slice(OracleAggregatorLayout.span + 1, OracleAggregatorLayout.span + 33)).toBase58();
  if (NATIVE_DEFAULT_BINDINGS.some(b => b.mint === mint)) return { step: "deactivate-default" as const, mint };
  if (legMints.includes(mint)) return { step: "add-token" as const, mint };
  throw new Error("RECOVERY_REQUIRED: pending token is not in this definition");
}

/** Resume one existing matching intent, or atomically open+execute a new one. Simulation returns
 * the actual native vault AND LUT post-state and checks the requested result before Sign is offered.
 * A stale/different pending task is never cancelled, overwritten, or blindly executed. */
export async function prepareCompositionTransactions(native: NativeVaultBuilders, request: CompositionRequest, build: () => Promise<TxPayloadBatchSequence>, simulate = true): Promise<KakuSanPreparedTx[]> {
  const key = new PublicKey(request.vault);
  const account = await native.connection.getAccountInfo(key, "confirmed");
  if (!account || account.owner.toBase58() !== SYMMETRY_PROGRAM_ID) throw new Error("COMPOSITION_IDENTITY: missing/wrong-owner vault");
  const vault = await native.sdk.fetchVault(request.vault);
  if (vault.ownAddress.toBase58() !== request.vault || vault.mint.toBase58() !== request.shareMint || vault.settings.creator.toBase58() !== request.creator) throw new Error("COMPOSITION_IDENTITY: vault/mint/deployer mismatch");
  const supply = await native.connection.getTokenSupply(vault.mint, "confirmed");
  if (supply.value.amount !== "0" || vault.composition.slice(0, vault.numTokens).some(a => a.amount.toString() !== "0")) throw new Error("COMPOSITION_FUNDED: initial installation only; inspect balances/supply before changing a funded vault");
  const type = request.token ? TaskType.AddToken : TaskType.UpdateWeights;
  let payload: TxPayloadBatchSequence;
  const pending = await pendingCompositionIntents(native, request.vault);
  const resume = pending.length > 0;
  if (resume) {
    const intent = pending[0];
    if (pending.length !== 1 || !intent?.ownAddress ||
        intent.vault.toBase58() !== request.vault || intent.manager.toBase58() !== request.creator || intent.taskType !== type ||
        (request.token && new PublicKey(intent.taskData.slice(OracleAggregatorLayout.span + 1, OracleAggregatorLayout.span + 33)).toBase58() !== request.token.token_mint)) {
      throw new Error("RECOVERY_REQUIRED: pending configuration differs from this step; preserve it and inspect before resuming");
    }
    if (!simulate) throw new Error("RECOVERY_REQUIRED: pending intent requires simulated post-state verification");
    payload = await native.executeConfiguration(request.creator, intent.ownAddress.toBase58());
  } else payload = await build();
  const { intent, ...prepared } = await atomicCompositionTransaction(native, payload, request.creator, resume);
  if (simulate) {
    const addresses = [request.vault, ...vault.lookupTables.active.map(k => k.toBase58()), intent];
    const result = await native.connection.simulateTransaction(VersionedTransaction.deserialize(Buffer.from(prepared.txBase64, "base64")), {
      sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses },
    });
    if (result.value.err) throw new Error(`Composition simulation failed: ${JSON.stringify(result.value.err)}${resume ? "; pending intent retained" : ""}`);
    const accounts = result.value.accounts;
    if (!accounts || accounts.length !== addresses.length || accounts.slice(0, -1).some(a => !a)) throw new Error("COMPOSITION_POST_STATE: native vault/LUT readback missing");
    if (accounts[0]!.owner !== SYMMETRY_PROGRAM_ID) throw new Error("COMPOSITION_POST_STATE: wrong vault owner");
    const remainingIntent = accounts.at(-1);
    if (remainingIntent && remainingIntent.lamports > 0 && (remainingIntent.owner !== SYMMETRY_PROGRAM_ID || IntentLayout.decode(Buffer.from(remainingIntent.data[0], "base64").subarray(8)).status !== IntentStatus.Completed)) throw new Error("COMPOSITION_POST_STATE: intent was not completed/closed");
    const data = Buffer.from(accounts[0]!.data[0], "base64");
    const post = { ...vault, ...VaultLayout.decode(data.subarray(8)), lutPubkeys: accounts.slice(1, -1).map((a, i) => new AddressLookupTableAccount({ key: vault.lookupTables.active[i], state: AddressLookupTableAccount.deserialize(Buffer.from(a!.data[0], "base64")) })) } as Vault;
    if (post.mint.toBase58() !== request.shareMint || !post.settings.activeManagements.isZero()) throw new Error("COMPOSITION_POST_STATE: identity or unsettled management mismatch");
    if (request.token) assertInstalledToken(post, request.token);
    else assertInstalledComposition(post, request.legs);
  }
  return [prepared];
}
