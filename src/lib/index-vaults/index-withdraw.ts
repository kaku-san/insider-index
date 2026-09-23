import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getAta, getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { createServiceSupabase } from "@/lib/supabase";
import { address, hashObject, rawAmount, sdkRawAmount } from "./amounts.ts";
import { validateAndSimulate } from "./transaction-policy.ts";
import { encodeCycleWire } from "./cycle-wire.ts";
import { kakuSanBuilders } from "./kaku-san-create.ts";
import { compileJupiterBuild, fetchJupiterBuild, type ParsedJupiterBuild } from "./jupiter-build.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";
import { VAULT_RELEASE } from "./release.ts";
import { networkUsdc, SYMMETRY_PROGRAM_ID, completeKeepTokens, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "./vault-definition-store.ts";
import {
  CLAIM_BATCH, EMPTY_KEEP_FORBIDDEN, ZAP_OUT_WARNING, assertKeepSelectionForUsdcGoal, claimDeltas, exitLegsFromDefinition,
  ownerClaimInstructions, planZapOut, type ExitLeg, type ZapOutPlan,
} from "./zap-out.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;
const INIT_REBALANCE_INTENT = Buffer.from([127, 215, 41, 110, 244, 179, 131, 7]);
const CREATE_REBALANCE_INTENT = Buffer.from([120, 80, 245, 123, 212, 149, 163, 47]);
const RESIZE_REBALANCE_INTENT = Buffer.from([71, 204, 243, 183, 209, 118, 111, 94]);
const UNSIMULABLE_CASH_OUT = "This cash out cannot be settled to USDC right now. Please try again later.";
const WAIT_FOR_BURN = "Waiting for the share burn to land. Nothing else was sent.";
const CLAIM_NOT_READY = "The basket is not claimable yet. This screen will check again.";
const CLAIM_NOT_FINAL = "The claim is not finalized yet.";
const SAFE_ERRORS = [
  "Invalid index ID.", "Request too large.", "A cash out request is required.", "Unexpected cash out field.",
  "Wallet owner is required.", "Share amount is required.", "USDC cash out is required.", "Idempotency key is invalid.",
  "Claim signature is invalid.", "Resume step is invalid.",
  "Cash out is not available for this vault.", "This vault is not on mainnet.", "Cash out is not open for signatures.",
  "Index not found.", "A cash out is already settling for this wallet.", UNSIMULABLE_CASH_OUT, EMPTY_KEEP_FORBIDDEN,
  WAIT_FOR_BURN, CLAIM_NOT_READY, CLAIM_NOT_FINAL, "The claim transaction failed.", "The claim was not signed by this wallet.",
  "The claim is not for this vault.", "Cash out claim mint is unsupported.", "Share amount exceeds the vault supply.",
  "Cash out has nothing left to claim.",
];

type WithdrawalInput = {
  owner: string;
  shareAmountRaw: string;
  requestedExitMode: "verified-native-usdc";
  idempotencyKey?: string;
  resume?: "claim" | "sell";
  claimSignature?: string;
};
type PayloadTransaction = { tx_b64: string; recent_blockhash: string; last_valid_block_height: number; payer: string; lookup_tables: unknown[] };
type ClaimRow = { mint: string; amountRaw: string; tokenProgram: string };
export type IndexWithdrawDependencies = {
  loadDefinition: (indexId: string) => Promise<PersistedVaultDefinition | null>;
  nativeBuilder: () => NativeVaultBuilders;
  release: Pick<typeof VAULT_RELEASE, "publicFundsEnabled">;
  loadClaim?: (native: NativeVaultBuilders, owner: string, vault: string) => Promise<ClaimRow[] | null>;
  loadClaimDeltas?: (native: NativeVaultBuilders, signature: string, owner: string, vault: string, intent: string) => Promise<{ mint: string; amountRaw: string }[]>;
  quoteSell?: (input: { inputMint: string; outputMint: string; amountRaw: string; taker: string; destinationTokenAccount: string }) => Promise<ParsedJupiterBuild | null>;
};

function defaultDependencies(): IndexWithdrawDependencies {
  return {
    loadDefinition: async indexId => {
      const db = createServiceSupabase();
      if (!db) throw new Error("Vault definitions are unavailable.");
      return readVaultDefinition(db, indexId);
    },
    nativeBuilder: () => kakuSanBuilders(false),
    release: VAULT_RELEASE,
    loadClaim: defaultLoadClaim,
    loadClaimDeltas: defaultClaimDeltas,
    quoteSell: input => fetchJupiterBuild(input),
  };
}
function plainError(error: unknown, status = 503) {
  const message = error instanceof Error ? error.message : "Cash out preparation is unavailable.";
  return Response.json({ error: SAFE_ERRORS.includes(message) ? message : UNSIMULABLE_CASH_OUT }, { status, headers: HEADERS });
}

export function parseIndexWithdrawalRequest(body: unknown): WithdrawalInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A cash out request is required.");
  const input = body as Record<string, unknown>;
  const allowed = ["owner", "shareAmountRaw", "requestedExitMode", "idempotencyKey", "resume", "claimSignature"];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unexpected cash out field.");
  if (typeof input.owner !== "string") throw new Error("Wallet owner is required.");
  if (typeof input.shareAmountRaw !== "string") throw new Error("Share amount is required.");
  if (input.requestedExitMode !== "verified-native-usdc") throw new Error("USDC cash out is required.");
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey))) throw new Error("Idempotency key is invalid.");
  if (input.resume != null && input.resume !== "claim" && input.resume !== "sell") throw new Error("Resume step is invalid.");
  if (input.claimSignature != null && (typeof input.claimSignature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(input.claimSignature))) throw new Error("Claim signature is invalid.");
  address(input.owner); rawAmount(input.shareAmountRaw, true); sdkRawAmount(input.shareAmountRaw);
  return {
    owner: input.owner, shareAmountRaw: input.shareAmountRaw, requestedExitMode: "verified-native-usdc",
    ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.resume === "claim" || input.resume === "sell" ? { resume: input.resume } : {}),
    ...(typeof input.claimSignature === "string" ? { claimSignature: input.claimSignature } : {}),
  };
}

function requireWithdrawalGate(definition: PersistedVaultDefinition, release: Pick<typeof VAULT_RELEASE, "publicFundsEnabled">) {
  if (!definition.vaultAddress || !definition.shareMint || definition.network !== "mainnet-beta") throw new Error(definition.network && definition.network !== "mainnet-beta" ? "This vault is not on mainnet." : "Cash out is not available for this vault.");
  if (!release.publicFundsEnabled) throw new Error("Cash out is not open for signatures.");
  address(definition.vaultAddress); address(definition.shareMint);
}
function instructionsFrom(transaction: VersionedTransaction): TransactionInstruction[] {
  if (transaction.message.addressTableLookups.length) throw new Error("Cash out transaction uses an unsupported lookup table.");
  return TransactionMessage.decompile(transaction.message).instructions;
}
function tokenMintsHash(mints: string[]): Buffer {
  let hash = Buffer.alloc(32);
  for (const mint of mints) hash = createHash("sha256").update(hash).update(new PublicKey(mint).toBuffer()).digest();
  return hash;
}
function keepMask(data: Buffer): bigint {
  return data.readBigUInt64LE(109) + (data.readBigUInt64LE(117) << 64n);
}
/** All-keep owner claim, or a non-empty mask that actually keeps USDC. Never an empty mask. */
function assertUsdcExitIntent(instructions: TransactionInstruction[], owner: string, vaultAddress: string, shareMint: string, sharesRaw: string, vaultMints: string[]) {
  const symmetry = instructions.filter(ix => ix.programId.toBase58() === SYMMETRY_PROGRAM_ID);
  if (symmetry.length !== 3 || !symmetry[0].data.equals(CREATE_REBALANCE_INTENT) || !symmetry[1].data.equals(RESIZE_REBALANCE_INTENT)) throw new Error("Cash out transaction has an unexpected native intent.");
  const create = symmetry[0], resize = symmetry[1], init = symmetry[2];
  const ownerKey = new PublicKey(owner), vault = new PublicKey(vaultAddress), mint = new PublicKey(shareMint);
  if (create.keys.length !== 9 || !create.keys[0]?.pubkey.equals(ownerKey) || !create.keys[0].isSigner || !create.keys[1]?.pubkey.equals(ownerKey) || !create.keys[2]?.pubkey.equals(vault) || !create.keys[3]?.isWritable || resize.keys.length !== 1 || !resize.keys[0]?.pubkey.equals(create.keys[3].pubkey) || !resize.keys[0].isWritable) throw new Error("Cash out intent accounts are invalid.");
  const mask = init.data.length === 126 ? keepMask(init.data) : 0n;
  const keepAll = init.data.length === 126 ? init.data[125] : 0;
  const usdcIndex = vaultMints.indexOf(networkUsdc("mainnet-beta"));
  const keepsUsdc = usdcIndex >= 0 && (mask & (1n << BigInt(usdcIndex))) !== 0n;
  if (!init.data.subarray(0, 8).equals(INIT_REBALANCE_INTENT) || init.data.length !== 126 || init.data[40] !== 1 || init.data.readBigUInt64LE(69) !== BigInt(sharesRaw) || !init.data.subarray(77, 109).equals(tokenMintsHash(vaultMints)) || mask === 0n || (keepAll !== 1 && !keepsUsdc)) throw new Error(mask === 0n ? EMPTY_KEEP_FORBIDDEN : "Cash out transaction is not the owner-claim path.");
  if (init.keys.length !== 18 || !init.keys[0]?.pubkey.equals(ownerKey) || !init.keys[0].isSigner || !init.keys[1]?.pubkey.equals(ownerKey) || !init.keys[2]?.pubkey.equals(vault) || !init.keys[3]?.pubkey.equals(create.keys[3].pubkey) || !init.keys[4]?.pubkey.equals(create.keys[4].pubkey) || !init.keys[5]?.pubkey.equals(mint) || !init.keys[14]?.pubkey.equals(new PublicKey(SYMMETRY_PROGRAM_ID))) throw new Error("Cash out transaction accounts are invalid.");
  const system = instructions.filter(ix => ix.programId.toBase58() === "11111111111111111111111111111111");
  const sync = instructions.filter(ix => ix.programId.equals(TOKEN_PROGRAM_ID));
  if (system.length !== 1 || system[0].data.length !== 12 || system[0].data.readUInt32LE(0) !== 2 || system[0].data.readBigUInt64LE(4) <= 0n || system[0].keys.length !== 2 || !system[0].keys[0]?.pubkey.equals(ownerKey) || !system[0].keys[0].isSigner || !system[0].keys[1]?.pubkey.equals(init.keys[9].pubkey) || sync.length !== 1 || sync[0].data.length !== 1 || sync[0].data[0] !== 17 || sync[0].keys.length !== 1 || !sync[0].keys[0]?.pubkey.equals(init.keys[9].pubkey)) throw new Error("Cash out bounty setup is invalid.");
  if (instructions.some(ix => ix.programId.equals(TOKEN_2022_PROGRAM_ID) || ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))) throw new Error("Cash out transaction contains unsupported token setup.");
}
function transactionPolicy(instructions: TransactionInstruction[], owner: string, maxDebits: { owner: string; mint: string; amountRaw: string }[], recipients: { owner: string; mint: string }[], minima: { mint: string; amountRaw: string }[] = [], decode: (ix: TransactionInstruction) => { debits: typeof maxDebits; recipients: typeof recipients; minima: typeof minima } = () => ({ debits: [], recipients: [], minima: [] })) {
  const programs = [...new Set(instructions.map(ix => ix.programId.toBase58()))];
  return {
    payer: owner, signers: [owner], programs,
    writableAccounts: [...new Set(instructions.flatMap(ix => ix.keys.filter(key => key.isWritable).map(key => key.pubkey.toBase58()))), owner],
    expectedInstructions: instructions,
    maxDebits, recipients, minima, maxComputeUnits: 1_400_000, maxMicroLamports: 100_000n,
    decode,
  };
}
function basePlan(indexId: string, legs: ExitLeg[], claims: { mint: string; amountRaw: string }[] = []): ZapOutPlan {
  return planZapOut({ indexId, usdcMint: MAINNET_USDC, legs, claims, quotes: null, unsupportedMints: [WSOL_MINT] });
}
function responseBody(input: { indexId: string; definition: PersistedVaultDefinition; owner: string; sharesRaw: string; phase: string; requires: "user-signature" | "wait"; transactions: unknown[]; plan: ZapOutPlan; blockers?: string[] }) {
  const operationId = `withdraw-${hashObject({ indexId: input.indexId, owner: input.owner, sharesRaw: input.sharesRaw, phase: input.phase, sells: input.plan.sells.map(sell => sell.mint) }).slice(0, 32)}`;
  return {
    network: "mainnet-beta" as const, operationId, phase: input.phase, requires: input.requires, transactions: input.transactions,
    configHash: hashObject({ indexId: input.indexId, vault: input.definition.vaultAddress, shareMint: input.definition.shareMint, mode: "zap-out", phase: input.phase }),
    constraints: [
      { label: "Settlement", value: "Staged owner claim, then Jupiter sells to USDC. Not an empty-keep auction." },
      { label: "Residual", value: input.plan.warning },
      { label: "Wallet approvals", value: "You approve each step" },
      { label: "Keeper funds", value: "0" },
    ],
    costs: { hostEntryFeeBps: input.definition.hostEntryFeeBps ?? 25, hostExitFeeBps: input.definition.hostExitFeeBps ?? 0, estimatedOnly: true },
    blockers: input.blockers ?? [],
    zapOut: input.plan,
  };
}

async function defaultLoadClaim(native: NativeVaultBuilders, owner: string, vaultAddress: string): Promise<ClaimRow[] | null> {
  const intent = getRebalanceIntentPda(new PublicKey(vaultAddress), new PublicKey(owner));
  const info = await native.connection.getAccountInfo(intent, "confirmed");
  if (!info) return null;
  const decoded = await native.sdk.fetchRebalanceIntent(intent.toBase58());
  const chain = decoded.chain_data;
  if (chain.owner.toBase58() !== owner || chain.vault.toBase58() !== vaultAddress) throw new Error("The claim is not for this vault.");
  if (chain.rebalanceType !== RebalanceType.Withdraw) throw new Error("A cash out is already settling for this wallet.");
  const tokens = chain.tokens.filter(token => !token.amount.isZero());
  const infos = tokens.length ? await native.connection.getMultipleAccountsInfo(tokens.map(token => token.mint), "confirmed") : [];
  return tokens.map((token, index) => {
    const program = infos[index]?.owner;
    if (!program || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(candidate => candidate.equals(program))) throw new Error("Cash out claim mint is unsupported.");
    return { mint: token.mint.toBase58(), amountRaw: BigInt(token.amount.toString()).toString(), tokenProgram: program.toBase58() };
  });
}
async function defaultClaimDeltas(native: NativeVaultBuilders, signature: string, owner: string, vault: string, intent: string) {
  const tx = await native.connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error(CLAIM_NOT_FINAL);
  const keys = tx.transaction.message.staticAccountKeys.map(key => key.toBase58());
  const row = (balance: { mint: string; owner?: string; uiTokenAmount: { amount: string } }) => ({ mint: balance.mint, owner: balance.owner, amountRaw: balance.uiTokenAmount.amount });
  return claimDeltas({
    owner, vault, intent, feePayer: keys[0] ?? "", accountKeys: keys, failed: Boolean(tx.meta?.err),
    pre: (tx.meta?.preTokenBalances ?? []).map(row), post: (tx.meta?.postTokenBalances ?? []).map(row),
  });
}

async function releaseWire(native: NativeVaultBuilders, stepId: string, txBase64: string, lastValidBlockHeight: number, owner: string, policy: Parameters<typeof validateAndSimulate>[2]) {
  try { return await validateAndSimulate(native.connection, { stepId, transactionBase64: txBase64, lastValidBlockHeight }, policy); }
  catch (error) {
    if (error instanceof Error && SAFE_ERRORS.includes(error.message)) throw error;
    throw new Error(UNSIMULABLE_CASH_OUT);
  }
}

export async function prepareIndexWithdrawal(indexId: string, input: WithdrawalInput, dependencies: IndexWithdrawDependencies = defaultDependencies()) {
  const definition = await dependencies.loadDefinition(indexId);
  if (!definition || definition.indexId !== indexId) throw new Error(definition ? "Cash out is not available for this vault." : "Index not found.");
  requireWithdrawalGate(definition, dependencies.release);
  const legs = exitLegsFromDefinition(definition.vaultLegs);
  const native = dependencies.nativeBuilder();
  await native.assertNetwork();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet vault builder required.");
  const vault = await native.sdk.fetchVault(definition.vaultAddress!);
  if (vault.ownAddress.toBase58() !== definition.vaultAddress || vault.mint.toBase58() !== definition.shareMint) throw new Error("Native vault identity mismatch.");
  const vaultMints = vault.composition.slice(0, vault.numTokens).map(token => token.mint.toBase58());
  if (!vaultMints.length) throw new Error("Cash out is not available for this vault.");
  const intent = getRebalanceIntentPda(new PublicKey(definition.vaultAddress!), new PublicKey(input.owner));
  const intentInfo = await native.connection.getAccountInfo(intent, "confirmed");
  if (input.resume === "claim" && !intentInfo) return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_WAIT", requires: "wait", transactions: [], plan: basePlan(indexId, legs), blockers: [WAIT_FOR_BURN] });
  if (intentInfo || input.claimSignature || input.resume === "sell") return prepareAfterBurn(indexId, input, definition, legs, native, intent.toBase58(), dependencies);
  return prepareBurn(indexId, input, definition, legs, native, vault, vaultMints);
}

async function prepareBurn(indexId: string, input: WithdrawalInput, definition: PersistedVaultDefinition, legs: ExitLeg[], native: NativeVaultBuilders, vault: Awaited<ReturnType<NativeVaultBuilders["sdk"]["fetchVault"]>>, vaultMints: string[]) {
  const keep = completeKeepTokens(vault);
  assertKeepSelectionForUsdcGoal(keep);
  const payload = await native.sdk.sellVaultTx({ seller: input.owner, vault_mint: definition.shareMint!, withdraw_amount: sdkRawAmount(input.shareAmountRaw), keep_tokens: keep, rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  const transactions = payload.batches.flatMap(batch => batch.transactions) as PayloadTransaction[];
  if (transactions.length !== 1) throw new Error("Cash out prepared an unexpected number of approvals.");
  const source = transactions[0];
  if (source.payer !== input.owner || !source.tx_b64 || !Number.isSafeInteger(source.last_valid_block_height) || source.last_valid_block_height <= 0 || source.lookup_tables.length) throw new Error("Cash out transaction is invalid.");
  const parsed = VersionedTransaction.deserialize(Buffer.from(source.tx_b64, "base64"));
  if (parsed.signatures.some(signature => signature.some(byte => byte !== 0)) || parsed.message.staticAccountKeys[0]?.toBase58() !== input.owner || parsed.message.recentBlockhash !== source.recent_blockhash) throw new Error("Cash out transaction identity mismatch.");
  const instructions = instructionsFrom(parsed);
  assertUsdcExitIntent(instructions, input.owner, definition.vaultAddress!, definition.shareMint!, input.shareAmountRaw, vaultMints);
  const transaction = await releaseWire(native, "zap-out-burn", source.tx_b64, source.last_valid_block_height, input.owner, transactionPolicy(instructions, input.owner, [{ owner: input.owner, mint: definition.shareMint!, amountRaw: input.shareAmountRaw }], [{ owner: input.owner, mint: networkUsdc("mainnet-beta") }]));
  return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_BURN", requires: "user-signature", transactions: [transaction], plan: basePlan(indexId, legs) });
}

async function prepareAfterBurn(indexId: string, input: WithdrawalInput, definition: PersistedVaultDefinition, legs: ExitLeg[], native: NativeVaultBuilders, intent: string, dependencies: IndexWithdrawDependencies) {
  if (input.claimSignature || input.resume === "sell") return prepareSells(indexId, input, definition, legs, native, intent, dependencies);
  const loadClaim = dependencies.loadClaim ?? defaultLoadClaim;
  const claims = await loadClaim(native, input.owner, definition.vaultAddress!);
  if (!claims?.length) return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_WAIT", requires: "wait", transactions: [], plan: basePlan(indexId, legs), blockers: [CLAIM_NOT_READY] });
  const batch = [...claims].sort((a, b) => a.mint < b.mint ? -1 : 1).slice(0, CLAIM_BATCH);
  const latest = await native.connection.getLatestBlockhash("confirmed");
  const instructions = ownerClaimInstructions({ owner: input.owner, vault: definition.vaultAddress!, claims: batch });
  const wire = encodeCycleWire({ payer: input.owner, blockhash: latest.blockhash, computeUnits: 400_000, microLamports: "25000", maxPriorityFeeLamports: "50000000", instructions });
  const recipients = batch.map(claim => ({ owner: input.owner, mint: claim.mint }));
  const transaction = await releaseWire(native, "zap-out-claim", wire.txBase64, latest.lastValidBlockHeight, input.owner, transactionPolicy(instructionsFrom(VersionedTransaction.deserialize(Buffer.from(wire.txBase64, "base64"))), input.owner, [], recipients));
  const plan = planZapOut({ indexId, usdcMint: MAINNET_USDC, legs, claims: batch.map(claim => ({ mint: claim.mint, amountRaw: claim.amountRaw })), quotes: null, unsupportedMints: [WSOL_MINT] });
  const blockers = claims.length > CLAIM_BATCH ? ["More names remain. Approve this claim, then check again."] : [];
  return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_CLAIM", requires: "user-signature", transactions: [transaction], plan, blockers });
}

async function prepareSells(indexId: string, input: WithdrawalInput, definition: PersistedVaultDefinition, legs: ExitLeg[], native: NativeVaultBuilders, intent: string, dependencies: IndexWithdrawDependencies) {
  if (!input.claimSignature) return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_WAIT", requires: "wait", transactions: [], plan: basePlan(indexId, legs), blockers: [CLAIM_NOT_FINAL] });
  const load = dependencies.loadClaimDeltas ?? defaultClaimDeltas;
  let deltas: { mint: string; amountRaw: string }[];
  try { deltas = await load(native, input.claimSignature, input.owner, definition.vaultAddress!, intent); }
  catch (error) {
    if (error instanceof Error && error.message === CLAIM_NOT_FINAL) return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_WAIT", requires: "wait", transactions: [], plan: basePlan(indexId, legs), blockers: [CLAIM_NOT_FINAL] });
    throw error;
  }
  const quote = dependencies.quoteSell ?? (row => fetchJupiterBuild(row));
  const usdcAta = getAta(new PublicKey(input.owner), new PublicKey(MAINNET_USDC), TOKEN_PROGRAM_ID).toBase58();
  const quotes: { mint: string; amountRaw: string; minOutRaw: string }[] = [];
  const transactions = [];
  for (const delta of deltas) {
    if (delta.mint === MAINNET_USDC || delta.mint === WSOL_MINT || !legs.some(leg => leg.mint === delta.mint)) continue;
    try {
      const parsed = await quote({ inputMint: delta.mint, outputMint: MAINNET_USDC, amountRaw: delta.amountRaw, taker: input.owner, destinationTokenAccount: usdcAta });
      if (!parsed) continue;
      const compiled = compileJupiterBuild(parsed);
      const transaction = await releaseWire(native, `zap-out-sell-${parsed.inputMint}`, compiled.txBase64, compiled.lastValidBlockHeight, input.owner, transactionPolicy(
        parsed.instructions, input.owner,
        [{ owner: input.owner, mint: parsed.inputMint, amountRaw: parsed.inAmount }],
        [{ owner: input.owner, mint: MAINNET_USDC }],
        [{ mint: MAINNET_USDC, amountRaw: parsed.minOutRaw }],
        ix => ix.programId.toBase58() === parsed.swapProgramId ? { debits: [{ owner: input.owner, mint: parsed.inputMint, amountRaw: parsed.inAmount }], recipients: [{ owner: input.owner, mint: MAINNET_USDC }], minima: [{ mint: MAINNET_USDC, amountRaw: parsed.minOutRaw }] } : { debits: [], recipients: [], minima: [] },
      ));
      quotes.push({ mint: delta.mint, amountRaw: delta.amountRaw, minOutRaw: parsed.minOutRaw });
      transactions.push(transaction);
    } catch { /* a missing route is a residual stock, not a keeper-funded retry */ }
  }
  const plan = planZapOut({ indexId, usdcMint: MAINNET_USDC, legs, claims: deltas, quotes, unsupportedMints: [WSOL_MINT] });
  if (!transactions.length) return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_OBSERVE", requires: "wait", transactions: [], plan, blockers: [plan.warning] });
  return responseBody({ indexId, definition, owner: input.owner, sharesRaw: input.shareAmountRaw, phase: "ZAP_OUT_SELL", requires: "user-signature", transactions, plan });
}

export async function handleIndexWithdrawalPrepare(request: Request, indexId: string, dependencies: IndexWithdrawDependencies = defaultDependencies()): Promise<Response> {
  if (!/^(insiderindex-|idx-theme-)[a-z0-9-]+$/.test(indexId)) return plainError(new Error("Invalid index ID."), 400);
  let input: WithdrawalInput;
  try {
    const text = await request.text();
    if (text.length > REQUEST_LIMIT) return plainError(new Error("Request too large."), 413);
    input = parseIndexWithdrawalRequest(JSON.parse(text));
  } catch (error) { return plainError(error, 400); }
  try { return Response.json(await prepareIndexWithdrawal(indexId, input, dependencies), { headers: HEADERS }); }
  catch (error) { return plainError(error); }
}

export { ZAP_OUT_WARNING };
