import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SymmetryCore } from "@symmetry-hq/sdk";
import type { TxPayloadBatchSequence, UIRebalanceIntent, Vault } from "@symmetry-hq/sdk";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { DEVNET_TEST_VAULT } from "./devnet-contract.ts";
import { devnetTestIdentity } from "./devnet-deposit.ts";
import { GENESIS, NativeVaultBuilders } from "./symmetry-adapter.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault, raydiumCpmmObservationTimestamp, raydiumPoolFor, WSOL_MINT } from "./raydium-oracles.ts";
import { rawAmount, sdkRawAmount, sha256 } from "./amounts.ts";

/** One existing devnet execution-test vault; the only identities this runner will ever touch. */
export const SETTLE_TEST_VAULT = Object.freeze({
  rpc: "https://api.devnet.solana.com",
  genesis: GENESIS.devnet,
  program: devnetTestIdentity.programId,
  vault: DEVNET_TEST_VAULT.vaultAccount,
  shareMint: DEVNET_TEST_VAULT.shareMint,
  usdcMint: DEVNET_TEST_VAULT.usdcMint,
  wallet: devnetTestIdentity.initialDeployer,
  defaultKeypairPath: `${homedir()}/.config/stocklana-devnet-keypair.json`,
  /** Raydium CPMM program that owns the documented devnet pool. */
  raydiumCpmmProgram: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
});

export type SettleStep = "observe" | "claim-bounty" | "deposit" | "lock" | "update-prices" | "mint";
export const SETTLE_STEPS: readonly SettleStep[] = Object.freeze(["observe", "claim-bounty", "deposit", "lock", "update-prices", "mint"]);
export interface SettleOptions { step: SettleStep; execute: boolean; intent?: string; usdcRaw?: string; maxSolDebit: string; keypairPath?: string }

/** Strict CLI parsing: unknown flags, mainnet, vault or wallet overrides are rejected. */
export function parseSettleArgs(argv: string[]): SettleOptions {
  const options: SettleOptions = { step: "observe", execute: false, maxSolDebit: "0.02" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`); return v; };
    if (flag === "--step") { const step = value(); if (!SETTLE_STEPS.includes(step as SettleStep)) throw new Error(`Unknown step ${step}`); options.step = step as SettleStep; }
    else if (flag === "--execute") options.execute = true;
    else if (flag === "--intent") options.intent = new PublicKey(value()).toBase58();
    else if (flag === "--usdc-raw") { options.usdcRaw = value(); rawAmount(options.usdcRaw, true); sdkRawAmount(options.usdcRaw); }
    else if (flag === "--max-sol-debit") { options.maxSolDebit = value(); solToLamports(options.maxSolDebit); }
    else if (flag === "--keypair") options.keypairPath = value();
    else throw new Error(`Unsupported argument ${flag}`);
  }
  if (["claim-bounty", "update-prices", "mint"].includes(options.step) && !options.intent) throw new Error(`--intent is required for ${options.step}`);
  if (options.step === "deposit" && !options.usdcRaw) throw new Error("--usdc-raw is required for deposit");
  return options;
}
export function solToLamports(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)) throw new Error("SOL amount must have at most nine decimals");
  const [whole, fraction = ""] = value.split(".");
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (lamports <= 0n) throw new Error("SOL budget must be positive");
  return lamports;
}

const READ_METHODS = /^(get|simulateTransaction$|isBlockhashValid$)/;
/** Devnet RPC only. Sends are permitted solely when `execute` is set; nothing else can broadcast. */
export function settleConnection(execute: boolean): Connection {
  return new Connection(SETTLE_TEST_VAULT.rpc, { commitment: "confirmed", fetchMiddleware: (info, init, next) => {
    if (String(info) !== SETTLE_TEST_VAULT.rpc) throw new Error("Devnet RPC only");
    const body = JSON.parse(String(init?.body));
    for (const call of Array.isArray(body) ? body : [body]) {
      const ok = typeof call.method === "string" && (READ_METHODS.test(call.method) || (execute && call.method === "sendTransaction"));
      if (!ok) throw new Error(`RPC method ${String(call.method)} is not permitted${execute ? "" : " in dry-run"}`);
    }
    next(info, init);
  } });
}

/** Loads the authorized devnet signer. The secret never leaves this closure; only the pubkey is compared. */
export function loadDevnetSigner(path: string = SETTLE_TEST_VAULT.defaultKeypairPath, expected: string = SETTLE_TEST_VAULT.wallet): Keypair {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error("Keypair file must be a 64-byte JSON array");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  parsed.fill(0);
  if (keypair.publicKey.toBase58() !== expected) throw new Error("Keypair does not match the authorized devnet test wallet");
  return keypair;
}

export type IntentNextAction = "deposit-tokens" | "update-prices" | "auction-wait" | "mint" | "redeem" | "claim-bounty" | "unknown";
export interface IntentObservation {
  pubkey: string; kind: "owner-deposit" | "vault-rebalance"; exists: boolean; rebalanceType?: string; currentAction?: string;
  nextAction?: IntentNextAction; auctionEnd?: number; bountyLeft?: number; priceUpdateCompletedAt?: number[]; mintCompletedAt?: number;
  prices?: { mint: string; price: number; updateTime: number }[];
}
/** SDK-derived stage: it fills exactly one *_data slot for the action a keeper should take next. */
export function intentNextAction(ui: UIRebalanceIntent): IntentNextAction {
  if (ui.deposit_data) return "deposit-tokens";
  if (ui.price_updates_data) return "update-prices";
  if (ui.auction_data) return "auction-wait";
  if (ui.mint_data) return "mint";
  if (ui.redeem_data) return "redeem";
  if (ui.claim_bounty_data) return "claim-bounty";
  return "unknown";
}

export interface SettleObservation {
  observedAt: string; observedSlot: number; network: "devnet"; vault: string; shareMint: string; stateHash: string;
  shareSupplyRaw: string; walletShareBalanceRaw: string; walletSolLamports: string; walletUsdcRaw: string | null; activeRebalance: string;
  oracles: { mint: string; oracleTypes: number[]; pool: string; sideQuote: boolean; stalenessThresh: string }[];
  raydiumPool: { pool: string; observationTimestamp: number; observationAgeSeconds: number; maxStalenessSeconds: number; fresh: boolean };
  holdings: { mint: string; amountRaw: string; weightBps: number }[];
  intents: IntentObservation[];
}

export class DevnetSettler {
  readonly connection: Connection;
  readonly native: NativeVaultBuilders;
  readonly sdk: SymmetryCore;
  constructor(connection: Connection) {
    this.connection = connection;
    this.native = new NativeVaultBuilders(connection, "devnet");
    this.sdk = this.native.sdk;
  }
  async vault(): Promise<{ vault: Vault; stateHash: string; shareSupplyRaw: string }> {
    const { vault, mint, stateHash } = await this.native.read(devnetTestIdentity);
    assertRaydiumOnlyVault(vault);
    return { vault, stateHash, shareSupplyRaw: mint.supply.toString() };
  }
  async intent(pubkey: string, kind: IntentObservation["kind"]): Promise<IntentObservation> {
    const account = await this.connection.getAccountInfo(new PublicKey(pubkey), "confirmed");
    if (!account) return { pubkey, kind, exists: false };
    const ui = await this.sdk.fetchRebalanceIntent(pubkey);
    if (ui.chain_data.vault.toBase58() !== SETTLE_TEST_VAULT.vault) throw new Error("Intent belongs to another vault");
    const f = ui.formatted_data;
    return { pubkey, kind, exists: true, rebalanceType: ui.rebalance_type, currentAction: f.current_action, nextAction: intentNextAction(ui),
      auctionEnd: f.auctions[2]?.end_time, bountyLeft: f.bounty.bounty_left, priceUpdateCompletedAt: f.price_update_tasks.map(t => t.completed_time),
      mintCompletedAt: f.mint_vault_task.completed_time, prices: f.tokens.map(t => ({ mint: t.mint, price: t.price.price, updateTime: t.price.update_time })) };
  }
  async pool(vault: Vault) {
    const binding = raydiumPoolFor(WSOL_MINT);
    const info = await this.connection.getAccountInfo(new PublicKey(binding.pool), "confirmed");
    if (!info || info.owner.toBase58() !== SETTLE_TEST_VAULT.raydiumCpmmProgram) throw new Error("Documented Raydium CPMM pool is missing or owned by another program");
    const state = RaydiumCpmmPoolState.decode(info.data, 8);
    const observation = await this.connection.getAccountInfo(state.observationKey, "confirmed");
    if (!observation) throw new Error("Raydium observation account missing");
    const timestamp = raydiumCpmmObservationTimestamp(observation.data);
    const maxStaleness = Math.min(...vault.composition.slice(0, vault.numTokens).flatMap(a => a.oracleAggregator.oracles.slice(0, a.oracleAggregator.numOracles).map(o => Number(o.oracleSettings.stalenessThresh.toString()))));
    const age = Math.floor(Date.now() / 1000) - timestamp;
    return { state, binding, summary: { pool: binding.pool, observationTimestamp: timestamp, observationAgeSeconds: age, maxStalenessSeconds: maxStaleness, fresh: age < maxStaleness } };
  }
  async observe(): Promise<SettleObservation> {
    const { vault, stateHash, shareSupplyRaw } = await this.vault();
    const wallet = new PublicKey(SETTLE_TEST_VAULT.wallet);
    const position = await this.native.position(devnetTestIdentity, SETTLE_TEST_VAULT.wallet);
    const usdc = await this.connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(SETTLE_TEST_VAULT.usdcMint), wallet), "confirmed").catch(() => null);
    const pool = await this.pool(vault);
    const vaultKey = new PublicKey(SETTLE_TEST_VAULT.vault);
    return {
      observedAt: new Date().toISOString(), observedSlot: await this.connection.getSlot("confirmed"), network: "devnet",
      vault: SETTLE_TEST_VAULT.vault, shareMint: SETTLE_TEST_VAULT.shareMint, stateHash, shareSupplyRaw,
      walletShareBalanceRaw: position.shareBalanceRaw, walletSolLamports: (await this.connection.getBalance(wallet, "confirmed")).toString(),
      walletUsdcRaw: usdc?.value.amount ?? null, activeRebalance: vault.settings.activeRebalance.toString(),
      oracles: vault.composition.slice(0, vault.numTokens).map(asset => {
        const oracle = asset.oracleAggregator.oracles[0];
        const table = vault.lutPubkeys?.[oracle.accountsToLoadLutIds[0]];
        return { mint: asset.mint.toBase58(), oracleTypes: asset.oracleAggregator.oracles.slice(0, asset.oracleAggregator.numOracles).map(o => o.oracleSettings.oracleType),
          pool: table?.state.addresses[oracle.accountsToLoadLutIndices[0]]?.toBase58() ?? "unknown", sideQuote: oracle.oracleSettings.side === 1, stalenessThresh: oracle.oracleSettings.stalenessThresh.toString() };
      }),
      raydiumPool: pool.summary,
      holdings: vault.composition.slice(0, vault.numTokens).map(a => ({ mint: a.mint.toBase58(), amountRaw: a.amount.toString(), weightBps: a.weight })),
      intents: [
        await this.intent(getRebalanceIntentPda(vaultKey, wallet).toBase58(), "owner-deposit"),
        await this.intent(getRebalanceIntentPda(vaultKey, vaultKey).toBase58(), "vault-rebalance"),
      ],
    };
  }

  /** Transactions for one step, as SDK payload batches (sequential batches, unsigned). */
  async build(options: SettleOptions): Promise<{ label: string; batches: VersionedTransaction[][]; notes: string[]; expectedOracleMints?: string[][] }> {
    const keeper = SETTLE_TEST_VAULT.wallet;
    const notes: string[] = [];
    if (options.step === "claim-bounty") {
      const intent = await this.intent(options.intent!, "owner-deposit");
      if (!intent.exists) throw new Error("Intent account is closed; nothing to claim");
      if (intent.nextAction !== "claim-bounty") throw new Error(`Intent stage is ${intent.nextAction}, not claim-bounty`);
      return { label: "claim-bounty", batches: fromPayload(await this.sdk.claimBountyTx({ keeper, rebalance_intent: options.intent! })), notes };
    }
    if (options.step === "update-prices") {
      const intent = await this.intent(options.intent!, "owner-deposit");
      if (intent.nextAction !== "update-prices") throw new Error(`Intent stage is ${intent.nextAction}, not update-prices`);
      const { vault } = await this.vault();
      const pool = await this.pool(vault);
      if (!pool.summary.fresh) throw new Error(`RAYDIUM_OBSERVATION_STALE: ${pool.summary.observationAgeSeconds}s >= ${pool.summary.maxStalenessSeconds}s`);
      const { payload, plan } = await this.native.priceUpdateFromVault(vault, keeper, options.intent!);
      notes.push(`oracle accounts: ${plan.oracleAccounts.map(a => a.join(",")).join(" | ")}`);
      return { label: "update-prices", batches: fromPayload(payload), notes,
        expectedOracleMints: plan.tokenIndices.map(indices => indices.map(index => plan.oracles[index].mint)) };
    }
    if (options.step === "mint") {
      const intent = await this.intent(options.intent!, "owner-deposit");
      if (intent.nextAction !== "mint") throw new Error(`Intent stage is ${intent.nextAction}, not mint`);
      return { label: "mint", batches: fromPayload(await this.sdk.mintTx({ keeper, rebalance_intent: options.intent! })), notes };
    }
    if (options.step === "deposit") {
      const existing = await this.native.ownerIntent(devnetTestIdentity, keeper);
      if (existing) throw new Error("Owner already has a native intent; finish or claim it first, never deposit twice");
      const payload = await this.native.deposit(devnetTestIdentity, keeper, options.usdcRaw!);
      notes.push("buyVaultTx = init intent + contribute; lock is the separate `lock` step");
      return { label: "deposit", batches: fromPayload(payload), notes };
    }
    if (options.step === "lock") {
      const intent = await this.intent(getRebalanceIntentPda(new PublicKey(SETTLE_TEST_VAULT.vault), new PublicKey(keeper)).toBase58(), "owner-deposit");
      if (intent.nextAction !== "deposit-tokens") throw new Error(`Intent stage is ${intent.nextAction}, not deposit-tokens`);
      return { label: "lock", batches: fromPayload(await this.native.lock(devnetTestIdentity, keeper)), notes };
    }
    throw new Error("observe builds nothing");
  }
}

export function fromPayload(payload: TxPayloadBatchSequence): VersionedTransaction[][] {
  return payload.batches.map(batch => batch.transactions.map(tx => VersionedTransaction.deserialize(Buffer.from(tx.tx_b64, "base64"))));
}

/** Program logs name the oracle type used for each priced token; type 2 = Raydium CPMM, 1 = CLMM, 0 = Pyth. */
export function oracleTypesFromLogs(logs: readonly string[]): { mint: string; oracleType: number; price: string }[] {
  const out: { mint: string; oracleType: number; price: string }[] = [];
  let mint: string | null = null;
  for (const line of logs) {
    const loading = /loading price for: ([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(line);
    if (loading) { mint = loading[1]; continue; }
    const oracle = /oracle: i \d+ type: (\d+) price: ([0-9.]+)/.exec(line);
    if (oracle && mint) out.push({ mint, oracleType: Number(oracle[1]), price: oracle[2] });
  }
  return out;
}
export function assertRaydiumLogs(logs: readonly string[], expectedMints: readonly string[] = []): void {
  const entries = oracleTypesFromLogs(logs);
  const forbidden = entries.filter(entry => entry.oracleType !== 1 && entry.oracleType !== 2);
  if (forbidden.length) throw new Error(`ORACLE_TYPE_FORBIDDEN in program logs: ${forbidden.map(f => `${f.mint}:${f.oracleType}`).join(", ")}`);
  const raydiumMints = new Set(entries.map(entry => entry.mint));
  const missing = expectedMints.filter(mint => !raydiumMints.has(mint));
  if (missing.length) throw new Error(`RAYDIUM_LOG_MISSING for priced mint: ${missing.join(", ")}`);
}

export function assertSolDebitBudget(spent: bigint, expectedFee: number | null, budget: bigint, label: string): void {
  if (expectedFee === null) throw new Error(`SOL fee unavailable before ${label}; refusing to send`);
  if (spent + BigInt(expectedFee) > budget) throw new Error(`SOL budget would be exceeded before ${label}; refusing to send`);
}

export interface StepReceipt {
  step: string; signature: string; slot: number; blockTime: number | null; feeLamports: number; walletDebitLamports: string; messageHash: string;
  oracleTypes: { mint: string; oracleType: number; price: string }[]; explorer: string;
}
export interface StepResult { step: SettleStep; mode: "dry-run" | "execute"; simulated: { messageHash: string; unitsConsumed: number | null; instructions: InstructionSummary[]; logsTail: string[] }[]; receipts: StepReceipt[]; notes: string[] }
export interface InstructionSummary { program: string; staticAccounts: string[]; lookupAccounts: number; discriminator: string }
/** Reviewable wire view: static keys are named, table-loaded keys are counted (resolved on-chain). */
export function summarizeInstructions(tx: VersionedTransaction): InstructionSummary[] {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.map(ix => ({
    program: keys[ix.programIdIndex]?.toBase58() ?? `lut:${ix.programIdIndex}`,
    staticAccounts: ix.accountKeyIndexes.filter(i => i < keys.length).map(i => keys[i].toBase58()),
    lookupAccounts: ix.accountKeyIndexes.filter(i => i >= keys.length).length,
    discriminator: Buffer.from(ix.data.subarray(0, 8)).toString("hex"),
  }));
}

export async function runSettleStep(settler: DevnetSettler, options: SettleOptions, signer?: Keypair): Promise<StepResult> {
  assertNoPythEnvironment();
  if (options.execute && !signer) throw new Error("Execute requires the authorized signer");
  if (await settler.connection.getGenesisHash() !== SETTLE_TEST_VAULT.genesis) throw new Error("RPC genesis/network mismatch");
  const built = await settler.build(options);
  const result: StepResult = { step: options.step, mode: options.execute ? "execute" : "dry-run", simulated: [], receipts: [], notes: built.notes };
  const wallet = new PublicKey(SETTLE_TEST_VAULT.wallet);
  const budget = solToLamports(options.maxSolDebit);
  let debit = 0n;
  let transactionIndex = 0;
  for (const [batchIndex, batch] of built.batches.entries()) {
    for (const tx of batch) {
      const expectedOracleMints = built.expectedOracleMints?.[transactionIndex++];
      const message = tx.message;
      if (!message.staticAccountKeys[0].equals(wallet)) throw new Error("Transaction payer is not the authorized wallet");
      if (!options.execute && batchIndex > 0) { result.notes.push(`batch ${batchIndex} depends on earlier batch state; not simulated in dry-run`); continue; }
      // Later batches are simulated only once earlier batches are finalized; each send uses a fresh blockhash.
      const simulation = await settler.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      const logs = simulation.value.logs ?? [];
      result.simulated.push({ messageHash: sha256(message.serialize()), unitsConsumed: simulation.value.unitsConsumed ?? null, instructions: summarizeInstructions(tx), logsTail: logs.slice(-6) });
      if (simulation.value.err) throw new Error(`Simulation failed for ${built.label}: ${JSON.stringify(simulation.value.err)} :: ${logs.filter(l => /Error|error/.test(l)).join(" | ")}`);
      assertRaydiumLogs(logs, expectedOracleMints);
      if (!options.execute) continue;
      const before = BigInt(await settler.connection.getBalance(wallet, "confirmed"));
      const latest = await settler.connection.getLatestBlockhash("confirmed");
      message.recentBlockhash = latest.blockhash;
      const fee = await settler.connection.getFeeForMessage(message, "confirmed");
      assertSolDebitBudget(debit, fee.value, budget, built.label);
      const messageHash = sha256(message.serialize());
      tx.sign([signer!]);
      const signature = await settler.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const confirmation = await settler.connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
      if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
      const receipt = await waitFinalized(settler.connection, signature);
      const after = BigInt(await settler.connection.getBalance(wallet, "confirmed"));
      debit += before - after;
      const receiptLogs = receipt.meta?.logMessages ?? [];
      assertRaydiumLogs(receiptLogs, expectedOracleMints);
      result.receipts.push({ step: built.label, signature, slot: receipt.slot, blockTime: receipt.blockTime ?? null, feeLamports: receipt.meta?.fee ?? 0,
        walletDebitLamports: (before - after).toString(), messageHash, oracleTypes: oracleTypesFromLogs(receiptLogs),
        explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
      if (debit > budget) throw new Error(`SOL budget ${options.maxSolDebit} exceeded after ${built.label}; stopping`);
    }
  }
  return result;
}

async function waitFinalized(connection: Connection, signature: string, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (tx) {
      if (tx.meta?.err) throw new Error(`Finalized transaction ${signature} failed: ${JSON.stringify(tx.meta.err)}`);
      return tx;
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Transaction ${signature} not finalized in time; reconcile before continuing`);
}
