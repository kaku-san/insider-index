import { createHash } from "node:crypto";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { SymmetryCore } from "@symmetry-hq/sdk";
import type { TxPayloadBatchSequence, Vault } from "@symmetry-hq/sdk";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { DEVNET_TEST_VAULT } from "./devnet-contract.ts";
import { devnetTestIdentity } from "./devnet-deposit.ts";
import { completeKeepTokens, GENESIS } from "./symmetry-adapter.ts";

/** One existing execution-test vault. No mainnet, signer, creation or send interface. */
export const REDEEM_TEST_VAULT = Object.freeze({
  rpc: "https://api.devnet.solana.com",
  genesis: GENESIS.devnet,
  program: devnetTestIdentity.programId,
  vault: DEVNET_TEST_VAULT.vaultAccount,
  mint: DEVNET_TEST_VAULT.shareMint,
  owner: devnetTestIdentity.initialDeployer,
  decimals: DEVNET_TEST_VAULT.shareDecimals,
});

const READ_METHODS = new Set([
  "getGenesisHash", "getAccountInfo", "getMultipleAccounts", "getTokenAccountsByOwner",
  "getBalance", "getTokenAccountBalance", "getMinimumBalanceForRentExemption", "getLatestBlockhash", "getSlot",
]);
export function assertRedeemReadRequest(body: string): void {
  const parsed = JSON.parse(body);
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!call || !READ_METHODS.has(call.method)) throw new Error("Redeem preflight RPC is read-only");
  }
}
export function redeemReadConnection(): Connection {
  return new Connection(REDEEM_TEST_VAULT.rpc, {
    commitment: "finalized",
    fetchMiddleware: (info, init, next) => {
      if (String(info) !== REDEEM_TEST_VAULT.rpc) throw new Error("Devnet RPC only");
      assertRedeemReadRequest(String(init?.body));
      next(info, init);
    },
  });
}

export function redeemRawAmount(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Shares must be a positive raw integer");
  const amount = BigInt(value);
  // sellVaultTx accepts a JS number, not bigint. Never silently round a burn amount.
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Shares exceed SDK safe integer limit");
  return amount;
}

export function redeemKeepTokens(vault: Pick<Vault, "numTokens" | "composition">): string[] {
  if (!Number.isInteger(vault.numTokens) || vault.numTokens < 1 || vault.numTokens > 100 || vault.composition.length < vault.numTokens) {
    throw new Error("Incomplete native vault composition");
  }
  const mints = completeKeepTokens(vault);
  if (mints.length !== vault.numTokens || mints.includes(PublicKey.default.toBase58())) throw new Error("Ambiguous native composition");
  return mints;
}

export type RedeemObservation = {
  observedSlot: number;
  walletLamports: number;
  shareSupplyRaw: string;
  shareBalanceRaw: string;
  spendableAtaSharesRaw: string;
  ownerIntent: string | null;
  activeVaultRebalance: boolean;
  keepTokens: string[];
};

export async function observeRedeem(connection: Connection, sdk: SymmetryCore): Promise<RedeemObservation> {
  const id = REDEEM_TEST_VAULT;
  if (connection.rpcEndpoint !== id.rpc || await connection.getGenesisHash() !== id.genesis) throw new Error("Devnet genesis/endpoint mismatch");
  const program = new PublicKey(id.program), vaultKey = new PublicKey(id.vault), mintKey = new PublicKey(id.mint), owner = new PublicKey(id.owner);
  const [programAccount, vaultAccount] = await connection.getMultipleAccountsInfo([program, vaultKey]);
  if (!programAccount?.executable || !vaultAccount?.owner.equals(program)) throw new Error("Native vault deployment mismatch");
  const vault = await sdk.fetchVault(id.vault);
  if (!vault.ownAddress.equals(vaultKey) || !vault.mint.equals(mintKey) || !vault.settings.creator.equals(owner) || !vault.settings.host.equals(owner)) throw new Error("Existing test vault identity mismatch");
  const mint = await getMint(connection, mintKey, "finalized", TOKEN_PROGRAM_ID);
  if (!mint.isInitialized || mint.decimals !== id.decimals || !mint.mintAuthority?.equals(vaultKey) || mint.freezeAuthority !== null) throw new Error("Native share mint mismatch");
  const accounts = await connection.getTokenAccountsByOwner(owner, { mint: mintKey }, "finalized");
  const ata = getAssociatedTokenAddressSync(mintKey, owner);
  let balance = BigInt(0), spendable = BigInt(0);
  for (const entry of accounts.value) {
    const account = unpackAccount(entry.pubkey, entry.account, TOKEN_PROGRAM_ID);
    if (!account.mint.equals(mintKey) || !account.owner.equals(owner)) throw new Error("Share account identity mismatch");
    balance += account.amount;
    if (entry.pubkey.equals(ata) && account.isInitialized && !account.isFrozen) spendable += account.amount;
  }
  const intent = getRebalanceIntentPda(vaultKey, owner);
  const intentAccount = await connection.getAccountInfo(intent);
  // Any existing account blocks a new burn, even if its contents cannot be decoded.
  return {
    observedSlot: accounts.context.slot,
    walletLamports: await connection.getBalance(owner, "finalized"),
    shareSupplyRaw: mint.supply.toString(), shareBalanceRaw: balance.toString(), spendableAtaSharesRaw: spendable.toString(),
    ownerIntent: intentAccount ? intent.toBase58() : null,
    activeVaultRebalance: !vault.settings.activeRebalance.isZero(),
    keepTokens: redeemKeepTokens(vault),
  };
}

/** Internal diagnostic builder only. Returned wire data must never be offered for signing. */
export async function buildRedeemDiagnostic(sdk: Pick<SymmetryCore, "sellVaultTx">, observation: RedeemObservation, sharesRaw: string) {
  const amount = redeemRawAmount(sharesRaw);
  if (observation.ownerIntent) throw new Error("Existing owner intent: reconcile before another burn");
  if (observation.activeVaultRebalance) throw new Error("Active vault rebalance: wait and re-attest");
  if (amount > BigInt(observation.spendableAtaSharesRaw) || amount > BigInt(observation.shareSupplyRaw)) throw new Error("Insufficient native shares");
  if (!observation.keepTokens.length || new Set(observation.keepTokens).size !== observation.keepTokens.length) throw new Error("Complete keep_tokens required");
  return sdk.sellVaultTx({
    seller: REDEEM_TEST_VAULT.owner, vault_mint: REDEEM_TEST_VAULT.mint,
    withdraw_amount: Number(amount), keep_tokens: observation.keepTokens,
    rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50,
  });
}

/** Decode compiled SDK wire bytes (not its descriptive instruction metadata).
 * This proves encoding only, NOT deployed program effects or safe broadcast. */
export function inspectRedeemEncoding(payload: TxPayloadBatchSequence, keepTokens: string[], sharesRaw: string) {
  if (payload.batches.length !== 1 || payload.batches[0].transactions.length !== 1) throw new Error("Unexpected sellVaultTx batch shape");
  const tx = VersionedTransaction.deserialize(Buffer.from(payload.batches[0].transactions[0].tx_b64, "base64"));
  if (tx.message.version !== 0 || tx.message.addressTableLookups.length) throw new Error("Unexpected withdrawal message format");
  if (tx.message.staticAccountKeys[0].toBase58() !== REDEEM_TEST_VAULT.owner || tx.message.header.numRequiredSignatures !== 1 || tx.signatures.some(s => s.some(b => b !== 0))) throw new Error("Expected unsigned test-wallet message");
  const discriminator = Buffer.from([127, 215, 41, 110, 244, 179, 131, 7]);
  const instructions = tx.message.compiledInstructions.filter(ix => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === REDEEM_TEST_VAULT.program && Buffer.from(ix.data).subarray(0, 8).equals(discriminator));
  if (instructions.length !== 1) throw new Error("Missing/ambiguous native withdrawal initialization");
  const ix = instructions[0], data = Buffer.from(ix.data);
  // SDK 1.0.22 ABI: discriminator + rent payer + kind + slippages + times/bounties + burn + mints hash + u128 mask + all flag.
  let expectedHash: Buffer = Buffer.alloc(32);
  for (const mint of keepTokens) expectedHash = createHash("sha256").update(expectedHash).update(new PublicKey(mint).toBuffer()).digest();
  const expectedMask = (BigInt(1) << BigInt(keepTokens.length)) - BigInt(1);
  if (data.length !== 126 || data[40] !== 1 || data.readBigUInt64LE(69) !== redeemRawAmount(sharesRaw) || !data.subarray(77, 109).equals(expectedHash) || (data.readBigUInt64LE(109) | (data.readBigUInt64LE(117) << BigInt(64))) !== expectedMask || data[125] !== 1) throw new Error("Unverified native sellVaultTx/keep_tokens encoding");
  for (const [index, expected] of [[0, REDEEM_TEST_VAULT.owner], [1, REDEEM_TEST_VAULT.owner], [2, REDEEM_TEST_VAULT.vault], [5, REDEEM_TEST_VAULT.mint]] as const) {
    if (tx.message.staticAccountKeys[ix.accountKeyIndexes[index]]?.toBase58() !== expected) throw new Error("Withdrawal account mismatch");
  }
  return { messageHash: createHash("sha256").update(tx.message.serialize()).digest("hex"), keepAllTokens: true, keepTokensMask: expectedMask.toString() };
}

export async function redeemPreflight(sharesRaw: string, dependencies: {
  observe: () => Promise<RedeemObservation>;
  build: (observation: RedeemObservation, sharesRaw: string) => Promise<TxPayloadBatchSequence>;
}) {
  const amount = redeemRawAmount(sharesRaw);
  const observation = await dependencies.observe();
  const blockers: string[] = [];
  if (observation.ownerIntent) blockers.push("EXISTING_OWNER_INTENT_RECONCILIATION_REQUIRED");
  if (observation.activeVaultRebalance) blockers.push("ACTIVE_VAULT_REBALANCE");
  if (BigInt(observation.shareBalanceRaw) === BigInt(0)) blockers.push("NO_WALLET_SHARES");
  if (amount > BigInt(observation.spendableAtaSharesRaw) || amount > BigInt(observation.shareSupplyRaw)) blockers.push("INSUFFICIENT_SPENDABLE_SHARES");
  let diagnostic = null;
  if (!blockers.length) {
    const payload = await dependencies.build(observation, sharesRaw);
    diagnostic = inspectRedeemEncoding(payload, observation.keepTokens, sharesRaw);
  }
  // No environment variable or CLI switch overrides this missing native roundtrip evidence.
  blockers.push("NATIVE_REDEEM_ROUNDTRIP_UNVERIFIED");
  return {
    network: "devnet", identity: REDEEM_TEST_VAULT, observedAt: new Date().toISOString(),
    requestedSharesRaw: sharesRaw, observation, mode: "native-in-kind", status: "BLOCKED",
    blockers, diagnostic, nativeRedeemVerified: false, usdcExit: false,
    transactionsSigned: 0, transactionsBroadcast: 0, redeemCompleted: false,
  };
}
