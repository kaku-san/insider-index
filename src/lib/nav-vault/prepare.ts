/**
 * One-signature deposit / exit for the NAV vault in the existing `PreparedStep` shape, so `VaultFlow`
 * shows one Approve each way:
 *   - deposit: USDC in, shares out (one tx).
 *   - exit: instant USDC when the free buffer covers it; otherwise ONE `request_withdraw` signature
 *     (the keeper converts the carved slice to USDC and pays it). An in-kind exit (paused / stale
 *     marks / explicitly requested) adds the claim to the same transaction when the legs fit.
 * No env, no `@/` aliases: callers pass the connection and program id.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import bs58 from "bs58";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction,
  type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CLAIM_LEGS_PER_TX, defaultProgramId, REQUEST_ACCOUNT_DISCRIMINATOR, SHARE_DECIMALS, SHARE_TOKEN_PROGRAM_ID, ata, claimInKindIx,
  computeNav, decodeRequest, decodeVault, depositIx, previewDeposit, previewWithdraw, requestPda, requestWithdrawIx, shareAta, tokenAmount,
  vaultPda, withSlippage, withdrawIx, type NavRequest, type NavVaultState, type WithdrawPath,
} from "./program.ts";

export type NavNetwork = "devnet" | "mainnet-beta";
export type NavConnection = Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction" | "getAddressLookupTable" | "getProgramAccounts">
  & Partial<Pick<Connection, "getRecentPrioritizationFees">>;
export const NAV_DEPOSIT_MINIMUM_RAW = 1_000_000n; // 1 USDC: keeps the entry fee and share rounding meaningful.
export const NAV_SLIPPAGE_BPS = 50;
/**
 * Marks must have this much life left when a transaction is prepared, so a signed deposit or USDC exit
 * does not land after the on-chain `max_price_age` (a `StalePrices` failure that still costs the fee).
 */
export const NAV_MARK_HEADROOM_SECS = 15;
/** Compute-unit price for user transactions: recent fees on the vault, clamped (mainnet landing). */
export const NAV_PRIORITY_DEFAULT_MICRO_LAMPORTS = 20_000;
export const NAV_PRIORITY_MIN_MICRO_LAMPORTS = 5_000;
export const NAV_PRIORITY_MAX_MICRO_LAMPORTS = 500_000;
/** New token accounts created inline with an in-kind claim; more go in preceding transactions (instruction trace limit). */
export const NAV_INLINE_ACCOUNT_CREATES = 3;
export const NAV_ACCOUNT_CREATES_PER_TX = 4;
export const NAV_STALE_PRICES = "Vault prices are stale. The keeper must refresh them before deposits and USDC exits.";
export const NAV_MARKS_TOO_NEW = "Vault prices were refreshed this slot. Try again in a moment.";
export const NAV_PAUSED = "This vault is paused. Deposits are closed; cash out is in kind.";

export type NavVaultSnapshot = {
  state: NavVaultState;
  usdcBalance: bigint;
  legBalances: bigint[];
  supply: bigint;
  nav: bigint;
  priceAgeSecs: number | null;
  pricesFresh: boolean;
};

export async function readNavVault(connection: NavConnection, indexId: string, programId = defaultProgramId(), nowSeconds = Math.floor(Date.now() / 1000)): Promise<NavVaultSnapshot | null> {
  const address = vaultPda(indexId, programId);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(programId)) throw new Error("NAV vault account has an unexpected owner.");
  const state = decodeVault(address, info.data);
  if (state.indexId !== indexId) throw new Error("NAV vault index id mismatch.");
  const accounts = await connection.getMultipleAccountsInfo([state.usdcAccount, state.shareMint, ...state.legs.map(leg => leg.account)], "confirmed");
  const usdcBalance = tokenAmount(accounts[0]?.data);
  const mint = accounts[1]?.data;
  if (!mint || mint.length < 82) throw new Error("NAV vault share mint is missing.");
  const supply = Buffer.from(mint).readBigUInt64LE(36);
  const legBalances = state.legs.map((_, i) => tokenAmount(accounts[i + 2]?.data));
  const nav = computeNav(state, usdcBalance, legBalances);
  const priceAgeSecs = state.pricesUpdatedAt > 0 ? Math.max(0, nowSeconds - state.pricesUpdatedAt) : null;
  const pricesFresh = priceAgeSecs !== null && priceAgeSecs <= state.maxPriceAgeSecs;
  return { state, usdcBalance, legBalances, supply, nav, priceAgeSecs, pricesFresh };
}

/** Fresh with headroom: a transaction prepared now still lands before the marks expire on chain. */
export function marksUsable(snapshot: Pick<NavVaultSnapshot, "priceAgeSecs" | "state">): boolean {
  return snapshot.priceAgeSecs !== null && snapshot.priceAgeSecs <= Math.max(0, snapshot.state.maxPriceAgeSecs - NAV_MARK_HEADROOM_SECS);
}

/** 75th percentile of recent non-zero prioritization fees on the vault account, clamped; a default when unavailable. */
export async function priorityMicroLamports(connection: NavConnection, vault: PublicKey): Promise<number> {
  try {
    const rows = await connection.getRecentPrioritizationFees?.({ lockedWritableAccounts: [vault] });
    const fees = (rows ?? []).map(row => row.prioritizationFee).filter(fee => fee > 0).sort((a, b) => a - b);
    const pick = fees.length ? fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))]! : NAV_PRIORITY_DEFAULT_MICRO_LAMPORTS;
    return Math.min(NAV_PRIORITY_MAX_MICRO_LAMPORTS, Math.max(NAV_PRIORITY_MIN_MICRO_LAMPORTS, pick));
  } catch { return NAV_PRIORITY_DEFAULT_MICRO_LAMPORTS; }
}

/** Open withdraw requests for a vault (null = every vault of the program), optionally one owner. */
export async function readNavRequests(connection: NavConnection, vault: PublicKey | null, owner?: PublicKey, programId = defaultProgramId()): Promise<NavRequest[]> {
  const filters = [
    { memcmp: { offset: 0, bytes: bs58.encode(REQUEST_ACCOUNT_DISCRIMINATOR) } },
    ...(vault ? [{ memcmp: { offset: 8, bytes: vault.toBase58() } }] : []),
    ...(owner ? [{ memcmp: { offset: 40, bytes: owner.toBase58() } }] : []),
  ];
  let rows: { pubkey: PublicKey; account: { data: Buffer | Uint8Array } }[] | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3 && !rows; attempt++) {
    try { rows = [...await connection.getProgramAccounts(programId, { commitment: "confirmed", filters })]; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1))); }
  }
  // Helius asks overloaded callers to use its paginated getProgramAccountsV2.
  if (!rows) rows = await programAccountsV2(connection, programId, filters).catch(() => null);
  if (!rows) throw lastError instanceof Error ? lastError : new Error("Open cash-out requests could not be read.");
  return rows.map(row => decodeRequest(row.pubkey, row.account.data)).sort((a, b) => a.createdAt - b.createdAt);
}

async function programAccountsV2(connection: NavConnection, programId: PublicKey, filters: unknown[]) {
  const endpoint = (connection as { rpcEndpoint?: string }).rpcEndpoint;
  if (!endpoint || !/helius/i.test(endpoint)) return null;
  const out: { pubkey: PublicKey; account: { data: Buffer } }[] = [];
  let paginationKey: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccountsV2", params: [programId.toBase58(), { encoding: "base64", commitment: "confirmed", filters, limit: 1000, ...(paginationKey ? { paginationKey } : {}) }] }) });
    const body = await response.json() as { result?: { accounts?: { pubkey: string; account: { data: [string, string] } }[]; paginationKey?: string | null }; error?: unknown };
    if (!response.ok || body.error || !body.result) return null;
    for (const row of body.result.accounts ?? []) out.push({ pubkey: new PublicKey(row.pubkey), account: { data: Buffer.from(row.account.data[0], "base64") } });
    if (!body.result.paginationKey) break;
    paginationKey = body.result.paginationKey;
  }
  return out;
}
export type NavUnsignedTransaction = {
  stepId: string;
  messageBase64: string;
  messageHash: string;
  requiredSigners: string[];
  allowedProgramIds: string[];
  maxDebits: { owner: string; mint: string; amountRaw: string }[];
  expectedRecipients: { owner: string; mint: string }[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  simulation?: { ok: true; slot: number; logsHash: string };
};
export type NavPreparedStep = {
  network: NavNetwork;
  operationId: string;
  phase: string;
  requires: "user-signature";
  transactions: NavUnsignedTransaction[];
  configHash: string;
  constraints: { label: string; value: string; strength?: string }[];
  costs: { hostEntryFeeBps: number; hostExitFeeBps: number; estimatedOnly: true };
  blockers: string[];
  estimate: { sharesRaw?: string; returnedUsdcRaw?: string; outputSummary: string };
  navVault: {
    vault: string;
    shareMint: string;
    path?: WithdrawPath;
    feeRaw?: string;
    request?: string;
    inKind?: { mint: string; amountRaw: string }[];
  };
};

const hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

async function lookupTables(connection: NavConnection, state: NavVaultState): Promise<AddressLookupTableAccount[]> {
  if (!state.lookupTable) return [];
  const table = (await connection.getAddressLookupTable(state.lookupTable)).value;
  return table ? [table] : [];
}

async function compile(connection: NavConnection, owner: PublicKey, instructions: TransactionInstruction[], tables: AddressLookupTableAccount[], simulate: boolean, priority?: number) {
  const latest = await connection.getLatestBlockhash("confirmed");
  // A compute-unit price so the user's transaction lands on a busy mainnet instead of being dropped.
  const priced = priority ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ...instructions] : instructions;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash, instructions: priced }).compileToV0Message(tables));
  let bytes: Uint8Array;
  try { bytes = tx.serialize(); } catch { throw new Error("The vault transaction does not fit in one transaction."); }
  const loaded = tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  if (bytes.length > 1232 || loaded > 64) throw new Error("The vault transaction does not fit in one transaction.");
  let simulation: NavUnsignedTransaction["simulation"];
  if (simulate) {
    const result = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
    if (result.value.err) throw new Error(simulationMessage(result.value.logs ?? [], result.value.err));
    simulation = { ok: true, slot: result.context.slot, logsHash: hex(new TextEncoder().encode((result.value.logs ?? []).join("\n"))) };
  }
  const programs = [...new Set(tx.message.compiledInstructions.map(ix => tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58()))];
  return { tx, bytes, programs, latest, simulation };
}

/** Plain user copy for the program's named errors. */
export function simulationMessage(logs: readonly string[], err?: unknown): string {
  const text = logs.join("\n");
  // A fee payer with no SOL fails before any program runs (no logs): same wallet-funds message.
  if (/AccountNotFound|InsufficientFundsForFee|InsufficientFundsForRent/.test(typeof err === "string" ? err : JSON.stringify(err ?? null))) return "This wallet does not have enough USDC or SOL.";
  if (/StalePrices/.test(text)) return NAV_STALE_PRICES;
  if (/MarksTooNew/.test(text)) return NAV_MARKS_TOO_NEW;
  if (/Error Code: Paused/.test(text)) return NAV_PAUSED;
  if (/SlippageExceeded/.test(text)) return "The vault value moved. Check the amount again.";
  if (/UsdcBufferShort/.test(text)) return "The vault USDC buffer changed. Check the cash out again.";
  if (/KeeperCannotDeposit/.test(text)) return "The keeper wallet cannot invest.";
  if (/DepositAboveCap/.test(text)) return "This deposit is above the per-deposit limit.";
  if (/NotClaimable/.test(text)) return "This cash out is still being converted to USDC. It can be claimed in kind after the timeout.";
  if (/insufficient funds/i.test(text)) return "This wallet does not have enough USDC or SOL.";
  return "The vault transaction did not simulate.";
}

function unsigned(stepId: string, owner: PublicKey, compiled: Awaited<ReturnType<typeof compile>>, debits: NavUnsignedTransaction["maxDebits"], recipients: NavUnsignedTransaction["expectedRecipients"]): NavUnsignedTransaction {
  return {
    stepId,
    messageBase64: Buffer.from(compiled.bytes).toString("base64"),
    messageHash: hex(compiled.tx.message.serialize()),
    requiredSigners: [owner.toBase58()],
    allowedProgramIds: compiled.programs,
    maxDebits: debits,
    expectedRecipients: recipients,
    recentBlockhash: compiled.latest.blockhash,
    lastValidBlockHeight: compiled.latest.lastValidBlockHeight,
    ...(compiled.simulation ? { simulation: compiled.simulation } : {}),
  };
}

function raw(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} is invalid.`);
  const n = BigInt(value);
  if (n <= 0n || n >= 1n << 64n) throw new Error(`${label} is invalid.`);
  return n;
}

export function formatUsdc(rawAmount: bigint) {
  const whole = rawAmount / 1_000_000n, fraction = (rawAmount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
const configHash = (state: NavVaultState) => hex(new TextEncoder().encode(`${state.address.toBase58()}:${state.entryFeeBps}:${state.bufferBps}:${state.requestTimeoutSecs}`));

export async function prepareNavDeposit(input: {
  connection: NavConnection; network: NavNetwork; indexId: string; owner: string; amountRaw: string;
  programId?: PublicKey; slippageBps?: number; simulate?: boolean; nowSeconds?: number;
}): Promise<NavPreparedStep> {
  const owner = new PublicKey(input.owner);
  const amount = raw(input.amountRaw, "USDC amount");
  if (amount < NAV_DEPOSIT_MINIMUM_RAW) throw new Error("The minimum is 1 USDC.");
  const programId = input.programId ?? defaultProgramId();
  const snapshot = await readNavVault(input.connection, input.indexId, programId, input.nowSeconds);
  if (!snapshot) throw new Error("This index does not have a NAV vault.");
  const { state } = snapshot;
  if (state.paused) throw new Error(NAV_PAUSED);
  if (owner.equals(state.keeper)) throw new Error("The keeper wallet cannot invest.");
  if (state.maxDepositUsdc > 0n && amount > state.maxDepositUsdc) throw new Error(`The limit is ${formatUsdc(state.maxDepositUsdc)} USDC per deposit.`);
  if (!marksUsable(snapshot)) throw new Error(NAV_STALE_PRICES);
  const userUsdc = await input.connection.getAccountInfo(ata(owner, state.usdcMint), "confirmed");
  if (tokenAmount(userUsdc?.data) < amount) throw new Error("This wallet does not have enough USDC.");
  const preview = previewDeposit({ usdcAmount: amount, entryFeeBps: state.entryFeeBps, nav: snapshot.nav, supply: snapshot.supply });
  if (preview.shares <= 0n) throw new Error("This amount is too small to mint a share unit.");
  const minShares = withSlippage(preview.shares, input.slippageBps ?? NAV_SLIPPAGE_BPS);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, shareAta(owner, state.shareMint), owner, state.shareMint, SHARE_TOKEN_PROGRAM_ID),
    depositIx(state, owner, amount, minShares, programId),
  ];
  const compiled = await compile(input.connection, owner, instructions, await lookupTables(input.connection, state), input.simulate ?? true, await priorityMicroLamports(input.connection, state.address));
  const transaction = unsigned("nav-deposit", owner, compiled, [{ owner: owner.toBase58(), mint: state.usdcMint.toBase58(), amountRaw: amount.toString() }], [{ owner: owner.toBase58(), mint: state.shareMint.toBase58() }]);
  return {
    network: input.network,
    operationId: `nav-deposit:${input.indexId}:${transaction.messageHash.slice(0, 16)}`,
    phase: "DEPOSIT",
    requires: "user-signature",
    transactions: [transaction],
    configHash: configHash(state),
    constraints: [
      { label: "Signatures", value: "One wallet approval. USDC in and shares out in the same transaction." },
      { label: "Entry fee", value: `${(state.entryFeeBps / 100).toFixed(2)}% (${formatUsdc(preview.fee)} USDC) funds keeper trade costs.` },
      { label: "Pending cash", value: "Your USDC is pending investment. The keeper buys the index names after your shares mint; weights drift until it fills." },
      { label: "Minimum shares", value: `${minShares} raw share units (${input.slippageBps ?? NAV_SLIPPAGE_BPS} bps slippage).` },
    ],
    costs: { hostEntryFeeBps: state.entryFeeBps, hostExitFeeBps: 0, estimatedOnly: true },
    blockers: [],
    estimate: { sharesRaw: preview.shares.toString(), outputSummary: `About ${formatUsdc(preview.shares)} shares at the current vault value.` },
    navVault: { vault: state.address.toBase58(), shareMint: state.shareMint.toBase58(), feeRaw: preview.fee.toString() },
  };
}

/**
 * Which of the owner's leg token accounts are missing. Existing accounts get no create instruction; up
 * to NAV_INLINE_ACCOUNT_CREATES missing ones are created inline, and beyond that every missing account
 * moves to preceding setup transactions. A new Token-2022 account costs ~5 trace entries, so creating
 * 10-11 inline beside the request and claim exceeds the 64-entry instruction trace limit.
 */
async function ownerLegAccounts(connection: NavConnection, owner: PublicKey, state: NavVaultState, legs: readonly number[]) {
  const infos = legs.length ? await connection.getMultipleAccountsInfo(legs.map(i => ata(owner, state.legs[i]!.mint, state.legs[i]!.tokenProgram)), "confirmed") : [];
  const missing = legs.filter((_, k) => !infos[k]);
  const inlineLegs = missing.length <= NAV_INLINE_ACCOUNT_CREATES ? missing : [];
  const setup = missing.length <= NAV_INLINE_ACCOUNT_CREATES ? [] : missing;
  const inline = inlineLegs.map(i => { const leg = state.legs[i]!; return createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, leg.mint, leg.tokenProgram), owner, leg.mint, leg.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID); });
  return { inline, inlineLegs, setup };
}

async function accountSetupTransactions(connection: NavConnection, owner: PublicKey, state: NavVaultState, legs: readonly number[], tables: AddressLookupTableAccount[], priority: number, simulate: boolean): Promise<NavUnsignedTransaction[]> {
  const out: NavUnsignedTransaction[] = [];
  for (let k = 0; k < legs.length; k += NAV_ACCOUNT_CREATES_PER_TX) {
    const chunk = legs.slice(k, k + NAV_ACCOUNT_CREATES_PER_TX);
    const ixs = chunk.map(i => { const leg = state.legs[i]!; return createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, leg.mint, leg.tokenProgram), owner, leg.mint, leg.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID); });
    const compiled = await compile(connection, owner, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs], tables, simulate, priority);
    out.push(unsigned(`nav-accounts-${out.length + 1}`, owner, compiled, [], chunk.map(i => ({ owner: owner.toBase58(), mint: state.legs[i]!.mint.toBase58() }))));
  }
  return out;
}

function nonceNow(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}

export async function prepareNavWithdraw(input: {
  connection: NavConnection; network: NavNetwork; indexId: string; owner: string; shareAmountRaw: string;
  /** Owner asks for the pro-rata basket now instead of a keeper USDC conversion. */
  inKind?: boolean;
  programId?: PublicKey; slippageBps?: number; simulate?: boolean; nowSeconds?: number; nonce?: bigint;
}): Promise<NavPreparedStep> {
  const owner = new PublicKey(input.owner);
  const shares = raw(input.shareAmountRaw, "Share amount");
  const programId = input.programId ?? defaultProgramId();
  const snapshot = await readNavVault(input.connection, input.indexId, programId, input.nowSeconds);
  if (!snapshot) throw new Error("This index does not have a NAV vault.");
  const { state } = snapshot;
  const userShares = await input.connection.getAccountInfo(shareAta(owner, state.shareMint), "confirmed");
  const heldShares = tokenAmount(userShares?.data);
  if (heldShares < shares) throw new Error("This wallet does not hold that many shares.");
  // Stale (or nearly stale) marks: refuse like a deposit so the client waits for the next mark and
  // re-prepares. In kind only when the owner asks for it or the vault is paused.
  if (!state.paused && !input.inKind && !marksUsable(snapshot)) throw new Error(NAV_STALE_PRICES);
  const preview = previewWithdraw({ vault: state, shares, nav: snapshot.nav, supply: snapshot.supply, usdcBalance: snapshot.usdcBalance, legBalances: snapshot.legBalances });
  const priced = marksUsable(snapshot) && !state.paused;
  const minUsdc = priced ? withSlippage(preview.value, input.slippageBps ?? NAV_SLIPPAGE_BPS) : 0n;
  const inKindNow = Boolean(input.inKind) || !priced;
  const path: WithdrawPath = priced && preview.instant && !input.inKind ? "usdc" : inKindNow ? "in-kind" : "request";
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, state.usdcMint), owner, state.usdcMint),
  ];
  const nonce = input.nonce ?? nonceNow();
  const request = requestPda(state.address, owner, nonce, programId);
  const tables = await lookupTables(input.connection, state);
  const priority = await priorityMicroLamports(input.connection, state.address);
  let setup: NavUnsignedTransaction[] = [];
  if (path === "usdc") {
    instructions.push(withdrawIx(state, owner, shares, minUsdc, programId));
  } else {
    instructions.push(requestWithdrawIx(state, owner, { shares, minUsdc, nonce, inKindNow }, programId));
    if (path === "in-kind" && state.legs.length <= CLAIM_LEGS_PER_TX) {
      const accounts = await ownerLegAccounts(input.connection, owner, state, state.legs.map((_, i) => i));
      setup = accounts.setup.length ? await accountSetupTransactions(input.connection, owner, state, accounts.setup, tables, priority, input.simulate ?? true) : [];
      instructions.push(...accounts.inline, claimInKindIx(state, owner, { address: request, owner }, state.legs.map((_, i) => i), programId));
    }
  }
  // A full exit closes the emptied share account so its rent returns to the owner (the burn runs first).
  if (shares === heldShares) instructions.push(createCloseAccountInstruction(shareAta(owner, state.shareMint), owner, owner, [], SHARE_TOKEN_PROGRAM_ID));
  // The main transaction cannot simulate before its setup transactions create the owner accounts.
  const compiled = await compile(input.connection, owner, instructions, tables, (input.simulate ?? true) && !setup.length, priority);
  const inKind = state.legs.map((leg, i) => ({ mint: leg.mint.toBase58(), amountRaw: preview.slice.legs[i]!.toString() }));
  const recipients = [{ owner: owner.toBase58(), mint: state.usdcMint.toBase58() }, ...(path === "in-kind" ? inKind.map(item => ({ owner: owner.toBase58(), mint: item.mint })) : [])];
  const transaction = unsigned(path === "usdc" ? "nav-withdraw" : "nav-request", owner, compiled, [{ owner: owner.toBase58(), mint: state.shareMint.toBase58(), amountRaw: shares.toString() }], recipients);
  const summary = path === "usdc"
    ? `About ${formatUsdc(preview.value)} USDC from the vault's USDC buffer.`
    : path === "request"
      ? `The vault's USDC buffer cannot cover this now. Your shares burn and your exact share of the vault (about ${formatUsdc(preview.value)} USDC at current marks) is set aside; the keeper sells it and sends USDC (at least ${formatUsdc(minUsdc)}). If that does not finish within ${Math.round(state.requestTimeoutSecs / 60)} minutes, you can claim the stocks and USDC in kind.`
      : `You receive your pro-rata share of the vault in kind: ${formatUsdc(preview.slice.usdc)} USDC plus ${inKind.filter(item => item.amountRaw !== "0").length} stock tokens. This is not a USDC exit.${state.legs.length > CLAIM_LEGS_PER_TX ? " Stocks are claimed in follow-up transactions." : ""}`;
  return {
    network: input.network,
    operationId: path === "usdc" ? `nav-withdraw:${input.indexId}:${transaction.messageHash.slice(0, 16)}` : `nav-request:${request.toBase58()}`,
    phase: path === "usdc" ? "WITHDRAW_USDC" : path === "request" ? "WITHDRAW_REQUEST" : "WITHDRAW_IN_KIND",
    requires: "user-signature",
    transactions: [...setup, transaction],
    configHash: configHash(state),
    constraints: [
      { label: "Signatures", value: "One wallet approval." },
      { label: "Exit rule", value: "USDC from the buffer when it covers the value; otherwise the keeper sells your carved pro-rata slice to USDC. Anything that cannot sell, or a timed-out request, is delivered in kind. Other holders are unaffected." },
    ],
    costs: { hostEntryFeeBps: state.entryFeeBps, hostExitFeeBps: 0, estimatedOnly: true },
    blockers: [],
    estimate: { returnedUsdcRaw: (path === "in-kind" ? preview.slice.usdc : preview.value).toString(), outputSummary: summary },
    navVault: { vault: state.address.toBase58(), shareMint: state.shareMint.toBase58(), path, ...(path !== "usdc" ? { request: request.toBase58() } : {}), ...(path === "in-kind" ? { inKind } : {}) },
  };
}

/** Owner claims an open request in kind (after its timeout). One tx per 13 legs. */
export async function prepareNavClaim(input: { connection: NavConnection; network: NavNetwork; indexId: string; owner: string; request: string; programId?: PublicKey; simulate?: boolean }): Promise<NavPreparedStep> {
  const owner = new PublicKey(input.owner);
  const programId = input.programId ?? defaultProgramId();
  const snapshot = await readNavVault(input.connection, input.indexId, programId);
  if (!snapshot) throw new Error("This index does not have a NAV vault.");
  const { state } = snapshot;
  const info = await input.connection.getAccountInfo(new PublicKey(input.request), "confirmed");
  if (!info) throw new Error("This cash out request is already finished.");
  const request = decodeRequest(new PublicKey(input.request), info.data);
  if (!request.owner.equals(owner) || !request.vault.equals(state.address)) throw new Error("This request belongs to another wallet.");
  const open = request.legAmounts.map((amount, i) => ({ amount, i })).filter(item => item.amount > 0n).map(item => item.i);
  const chunks: number[][] = [];
  for (let k = 0; k < Math.max(open.length, 1); k += CLAIM_LEGS_PER_TX) chunks.push(open.slice(k, k + CLAIM_LEGS_PER_TX));
  const tables = await lookupTables(input.connection, state);
  const priority = await priorityMicroLamports(input.connection, state.address);
  const accounts = await ownerLegAccounts(input.connection, owner, state, open);
  // Owner accounts that would push a claim past the instruction trace limit are created first.
  const transactions: NavUnsignedTransaction[] = accounts.setup.length ? await accountSetupTransactions(input.connection, owner, state, accounts.setup, tables, priority, input.simulate ?? true) : [];
  const inline = new Set(accounts.inlineLegs);
  for (const [n, legs] of chunks.entries()) {
    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, state.usdcMint), owner, state.usdcMint),
      ...legs.filter(i => inline.has(i)).map(i => { const leg = state.legs[i]!; return createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, leg.mint, leg.tokenProgram), owner, leg.mint, leg.tokenProgram); }),
      claimInKindIx(state, owner, request, legs, programId),
    ];
    const compiled = await compile(input.connection, owner, ixs, tables, (input.simulate ?? true) && n === 0 && !accounts.setup.length, priority);
    transactions.push(unsigned(`nav-claim-${n + 1}`, owner, compiled, [], legs.map(i => ({ owner: owner.toBase58(), mint: state.legs[i]!.mint.toBase58() }))));
  }
  return {
    network: input.network, operationId: `nav-claim:${request.address.toBase58()}`, phase: "CLAIM_IN_KIND", requires: "user-signature", transactions,
    configHash: configHash(state), constraints: [{ label: "Claim", value: "Delivers your carved stocks and USDC in kind to this wallet." }],
    costs: { hostEntryFeeBps: state.entryFeeBps, hostExitFeeBps: 0, estimatedOnly: true }, blockers: [],
    estimate: { returnedUsdcRaw: request.usdcOwed.toString(), outputSummary: `${formatUsdc(request.usdcOwed)} USDC plus ${open.length} stock tokens.` },
    navVault: { vault: state.address.toBase58(), shareMint: state.shareMint.toBase58(), path: "in-kind", request: request.address.toBase58() },
  };
}

export { SHARE_DECIMALS };
