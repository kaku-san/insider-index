import { PublicKey, TransactionMessage, SystemInstruction, SystemProgram, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { sha256, rawAmount } from "../index-vaults/amounts.ts";
import { readCycleMemo } from "../index-vaults/cycle-memo-parse.ts";
import { decodeCycleReceipt, type CycleMintBinding } from "../index-vaults/cycle-receipt-parse.ts";
import type { CyclePolicy } from "../index-vaults/cycle-policy-parse.ts";
import { MAINNET_USDC } from "../index-vaults/native-defaults.ts";
import { WSOL_MINT } from "../index-vaults/raydium-oracles.ts";

const pk = (s: string) => new PublicKey(s);
const INIT = Buffer.from([127, 215, 41, 110, 244, 179, 131, 7]);
const account = (owner: string, m: CycleMintBinding) => getAssociatedTokenAddressSync(pk(m.mint), pk(owner), false, pk(m.tokenProgram));
export interface CycleWalletHistory {
  ownerSolDebitLamports: bigint; bountyFundingRaw: bigint; contributedUsdcRaw: bigint;
  mintedSharesRaw: bigint; burnedSharesRaw: bigint; recoveredUsdcRaw: bigint;
  remainingCredits: Map<string, bigint>; depositSignature: string | null; exitSignature: string | null;
  externalCreditDisposal: boolean;
}

/** Independent read-only RPC history, never a server journal's credits/sold totals. Scan the
 * canonical ATAs too: issuer/permanent-delegate debits need not mention the owner's pubkey.
 * Bounded/pruned/racing history refuses signing rather than guessing that credits are unspent.
 * RPC completeness remains a trust assumption; this is not a native-program guarantee. */
export async function readCycleWalletHistory(connection: Connection, policy: CyclePolicy, mints: readonly CycleMintBinding[]): Promise<CycleWalletHistory> {
  const intent = getRebalanceIntentPda(pk(policy.vault), pk(policy.owner));
  const addresses = [pk(policy.owner), intent, ...mints.map(m => account(policy.owner, m))];
  const root = await connection.getSlot("finalized");
  if (root < policy.notBeforeSlot) throw new Error("CYCLE_WALLET_HISTORY_BEFORE_AUTHORITY");
  const signatures = new Map<string, number>(), heads = new Map<string, string | null>();
  for (const address of addresses) {
    let before: string | undefined, finished = false;
    for (let page = 0; page < 12 && !finished; page++) {
      const rows = await connection.getSignaturesForAddress(address, { before, limit: 100, minContextSlot: root }, "finalized");
      if (!before) heads.set(address.toBase58(), rows[0]?.signature ?? null);
      for (const row of rows) {
        if (row.slot < policy.notBeforeSlot) { finished = true; break; }
        if (row.slot > root) throw new Error("CYCLE_WALLET_HISTORY_MOVED_RETRY");
        signatures.set(row.signature, row.slot);
        if (signatures.size > 1024) throw new Error("CYCLE_WALLET_HISTORY_LIMIT_RECOVERY_REQUIRED");
      }
      if (rows.length < 100) finished = true;
      const next = rows.at(-1)?.signature;
      if (next && next === before) throw new Error("CYCLE_WALLET_HISTORY_CURSOR");
      before = next;
    }
    if (!finished) throw new Error("CYCLE_WALLET_HISTORY_LIMIT_RECOVERY_REQUIRED");
  }
  const transactions: VersionedTransactionResponse[] = [];
  for (const [signature, slot] of signatures) {
    const tx = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.slot !== slot || tx.transaction.signatures[0] !== signature) throw new Error("CYCLE_WALLET_HISTORY_UNAVAILABLE");
    transactions.push(tx);
  }
  // Stable heads detect newly finalized wallet/issuer/native activity during the scan.
  for (const address of addresses) {
    const head = await connection.getSignaturesForAddress(address, { limit: 1, minContextSlot: root }, "finalized");
    if ((head[0]?.signature ?? null) !== heads.get(address.toBase58())) throw new Error("CYCLE_WALLET_HISTORY_MOVED_RETRY");
  }
  // Same-slot ordering must come from the canonical finalized block, not map insertion or a
  // server's receipt list. A missing block never licenses a second sale.
  const ordered: VersionedTransactionResponse[] = [];
  for (const slot of [...new Set(transactions.map(t => t.slot))].sort((a, b) => a - b)) {
    const group = transactions.filter(t => t.slot === slot);
    if (group.length === 1) { ordered.push(group[0]); continue; }
    const block = await connection.getBlockSignatures(slot, "finalized");
    if (!block) throw new Error("CYCLE_WALLET_HISTORY_BLOCK_UNAVAILABLE");
    const positions = new Map(block.signatures.map((s, i) => [s, i]));
    if (group.some(t => !positions.has(t.transaction.signatures[0]))) throw new Error("CYCLE_WALLET_HISTORY_BLOCK_MISMATCH");
    ordered.push(...group.sort((a, b) => positions.get(a.transaction.signatures[0])! - positions.get(b.transaction.signatures[0])!));
  }
  return auditCycleWalletHistory(ordered, policy, mints);
}

/** Pure accounting over canonical chronological, finalized RPC history. No wallet balance or
 * incoming purchase replenishes a previously consumed native claim. Call the RPC wrapper above. */
export function auditCycleWalletHistory(transactions: readonly VersionedTransactionResponse[], policy: CyclePolicy, mints: readonly CycleMintBinding[]): CycleWalletHistory {
  const result: CycleWalletHistory = { ownerSolDebitLamports: 0n, bountyFundingRaw: 0n, contributedUsdcRaw: 0n, mintedSharesRaw: 0n, burnedSharesRaw: 0n, recoveredUsdcRaw: 0n, remainingCredits: new Map(), depositSignature: null, exitSignature: null, externalCreditDisposal: false };
  const intent = getRebalanceIntentPda(pk(policy.vault), pk(policy.owner)).toBase58();
  const atas = new Map(mints.map(m => [m.mint, account(policy.owner, m).toBase58()]));
  let generation: "deposit" | "withdraw" | null = null, lastSlot = policy.notBeforeSlot;
  const seen = new Set<string>();
  for (const tx of transactions) {
    const { message, signatures } = tx.transaction, meta = tx.meta, signature = signatures[0];
    if (!meta || tx.slot < lastSlot || seen.has(signature) || signatures.length !== message.header.numRequiredSignatures || !signatures.length) throw new Error("CYCLE_WALLET_HISTORY_IDENTITY");
    lastSlot = tx.slot; seen.add(signature);
    for (let n = 0; n < signatures.length; n++) if (!ed25519.verify(bs58.decode(signatures[n]), message.serialize(), message.staticAccountKeys[n].toBytes(), { zip215: false })) throw new Error("CYCLE_WALLET_HISTORY_SIGNATURE");
    const keys = message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });
    const at = (n: number) => keys.get(n)?.toBase58();
    const native = message.compiledInstructions.filter(i => at(i.programIdIndex) === VAULTS_V3_PROGRAM_ID.toBase58() && i.accountKeyIndexes.some(n => at(n) === intent));
    const marker = readCycleMemo(message, meta.loadedAddresses, policy);
    const payer = message.staticAccountKeys[0].toBase58();
    if ((marker || (generation && native.length)) && payer === policy.owner) {
      if (![meta.fee, meta.preBalances[0], meta.postBalances[0]].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("CYCLE_WALLET_HISTORY_SOL_PRECISION");
      result.ownerSolDebitLamports += BigInt(Math.max(meta.fee, meta.preBalances[0] - meta.postBalances[0]));
    }
    if (meta.err) continue;
    if (native.some(i => Buffer.from(i.data).subarray(0, 8).equals(INIT))) {
      if (!marker || !["create", "withdraw"].includes(marker)) {
        if (generation || result.depositSignature) throw new Error("CYCLE_WALLET_FOREIGN_NATIVE_GENERATION");
      } else {
        const field = marker === "create" ? "depositSignature" : "exitSignature";
        if (result[field] || generation || (marker === "withdraw" && !result.depositSignature)) throw new Error("CYCLE_WALLET_REPEATED_NATIVE_GENERATION");
        result[field] = signature; generation = marker === "create" ? "deposit" : "withdraw";
        const transfer = TransactionMessage.decompile(message, { accountKeysFromLookups: meta.loadedAddresses ?? { writable: [], readonly: [] } }).instructions.find(i => i.programId.equals(SystemProgram.programId));
        if (!transfer || SystemInstruction.decodeInstructionType(transfer) !== "Transfer") throw new Error("CYCLE_WALLET_BOUNTY_HISTORY");
        const funding = SystemInstruction.decodeTransfer(transfer);
        if (funding.fromPubkey.toBase58() !== policy.owner || funding.toPubkey.toBase58() !== atas.get(WSOL_MINT)) throw new Error("CYCLE_WALLET_BOUNTY_HISTORY");
        result.bountyFundingRaw += funding.lamports;
      }
    }
    const deltas = new Map<string, bigint>();
    for (const m of mints) {
      const balance = (rows: typeof meta.preTokenBalances) => {
        if (!rows) throw new Error("CYCLE_WALLET_HISTORY_TOKEN_METADATA");
        const matches = rows.filter(r => at(r.accountIndex) === atas.get(m.mint));
        if (matches.length > 1 || matches.some(r => r.mint !== m.mint || r.owner !== policy.owner || r.programId !== m.tokenProgram || r.uiTokenAmount.decimals !== m.decimals)) throw new Error("CYCLE_WALLET_HISTORY_TOKEN_IDENTITY");
        return matches.length ? rawAmount(matches[0].uiTokenAmount.amount) : 0n;
      };
      deltas.set(m.mint, balance(meta.postTokenBalances) - balance(meta.preTokenBalances));
    }
    if (generation && native.length) {
      const decoded = decodeCycleReceipt(tx, { signature, messageHash: sha256(message.serialize()), payer, owner: policy.owner, vault: policy.vault, shareMint: policy.shareMint, operationId: policy.operationId, minSlot: policy.notBeforeSlot, mints });
      if (decoded.mintedShares && generation !== "deposit") throw new Error("CYCLE_WALLET_MINT_OUTSIDE_DEPOSIT");
      if (decoded.burnedShares && (generation !== "withdraw" || marker !== "withdraw")) throw new Error("CYCLE_WALLET_BURN_OUTSIDE_WITHDRAWAL");
      if (decoded.mintedShares) result.mintedSharesRaw += decoded.ownerShareDelta;
      result.burnedSharesRaw += decoded.burnedShares;
      for (const c of decoded.credits) {
        if (c.mint === MAINNET_USDC) result.recoveredUsdcRaw += rawAmount(c.receivedRaw);
        else result.remainingCredits.set(c.mint, (result.remainingCredits.get(c.mint) ?? 0n) + rawAmount(c.receivedRaw));
      }
      if (marker === "contribute") {
        const debit = -(deltas.get(MAINNET_USDC) ?? 0n);
        if (debit !== rawAmount(policy.limits.depositUsdcRaw) || result.contributedUsdcRaw) throw new Error("CYCLE_WALLET_REPEATED_CONTRIBUTION");
        result.contributedUsdcRaw += debit;
      }
      const intentIndex = Array.from({ length: keys.length }, (_, n) => n).find(n => at(n) === intent);
      if (intentIndex !== undefined && meta.postBalances[intentIndex] === 0) generation = null;
    }
    let sold = 0;
    for (const [mint, remaining] of result.remainingCredits) {
      const delta = deltas.get(mint) ?? 0n;
      if (delta >= 0n) continue;
      const used = -delta > remaining ? remaining : -delta;
      if (!used) continue;
      result.remainingCredits.set(mint, remaining - used); sold++;
      if (marker !== "convert" || used !== -delta) result.externalCreditDisposal = true;
    }
    if (marker === "convert") {
      const usdc = deltas.get(MAINNET_USDC) ?? 0n;
      if (sold !== 1 || usdc <= 0n || result.externalCreditDisposal) throw new Error("CYCLE_WALLET_CONVERSION_WITHOUT_CREDIT");
      result.recoveredUsdcRaw += usdc;
    }
  }
  return result;
}
