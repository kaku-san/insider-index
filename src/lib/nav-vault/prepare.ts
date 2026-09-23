/**
 * One-signature deposit / exit for the NAV vault. Each prepare returns EXACTLY ONE unsigned
 * transaction in the existing `PreparedStep` shape, so `VaultFlow` shows one Approve each way.
 * No env, no `@/` aliases: callers pass the connection and program id.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction,
  type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  NAV_VAULT_PROGRAM_ID, SHARE_DECIMALS, ata, computeNav, decodeVault, depositIx, previewDeposit, previewWithdraw, tokenAmount,
  vaultPda, withSlippage, withdrawInKindIx, withdrawIx, type NavVaultState, type WithdrawPath,
} from "./program.ts";

export type NavNetwork = "devnet" | "mainnet-beta";
export type NavConnection = Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getLatestBlockhash" | "simulateTransaction" | "getAddressLookupTable">;
export const NAV_DEPOSIT_MINIMUM_RAW = 1_000_000n; // 1 USDC: keeps the entry fee and share rounding meaningful.
export const NAV_SLIPPAGE_BPS = 50;
export const NAV_STALE_PRICES = "Vault prices are stale. The keeper must refresh them before deposits and USDC exits.";
export const NAV_MARKS_TOO_NEW = "Vault prices were refreshed this slot. Try again in a moment.";

export type NavVaultSnapshot = {
  state: NavVaultState;
  usdcBalance: bigint;
  legBalances: bigint[];
  supply: bigint;
  nav: bigint;
  priceAgeSecs: number | null;
  pricesFresh: boolean;
};

export async function readNavVault(connection: NavConnection, indexId: string, programId = NAV_VAULT_PROGRAM_ID, nowSeconds = Math.floor(Date.now() / 1000)): Promise<NavVaultSnapshot | null> {
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
  transactions: [NavUnsignedTransaction];
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
    inKind?: { mint: string; amountRaw: string }[];
  };
};

const hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

async function lookupTables(connection: NavConnection, state: NavVaultState): Promise<AddressLookupTableAccount[]> {
  if (!state.lookupTable) return [];
  const table = (await connection.getAddressLookupTable(state.lookupTable)).value;
  return table ? [table] : [];
}

async function compile(connection: NavConnection, owner: PublicKey, instructions: TransactionInstruction[], tables: AddressLookupTableAccount[], simulate: boolean) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash, instructions }).compileToV0Message(tables));
  let bytes: Uint8Array;
  try { bytes = tx.serialize(); } catch { throw new Error("The vault transaction does not fit in one transaction."); }
  if (bytes.length > 1232) throw new Error("The vault transaction does not fit in one transaction.");
  let simulation: NavUnsignedTransaction["simulation"];
  if (simulate) {
    const result = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
    if (result.value.err) throw new Error(simulationMessage(result.value.logs ?? []));
    simulation = { ok: true, slot: result.context.slot, logsHash: hex(new TextEncoder().encode((result.value.logs ?? []).join("\n"))) };
  }
  const programs = [...new Set(tx.message.compiledInstructions.map(ix => tx.message.staticAccountKeys[ix.programIdIndex]!.toBase58()))];
  return { tx, bytes, programs, latest, simulation };
}

/** Plain user copy for the program's named errors. */
export function simulationMessage(logs: readonly string[]): string {
  const text = logs.join("\n");
  if (/StalePrices/.test(text)) return NAV_STALE_PRICES;
  if (/MarksTooNew/.test(text)) return NAV_MARKS_TOO_NEW;
  if (/SlippageExceeded/.test(text)) return "The vault value moved. Check the amount again.";
  if (/UsdcBufferShort/.test(text)) return "The vault USDC buffer changed. Check the cash out again.";
  if (/KeeperCannotDeposit/.test(text)) return "The keeper wallet cannot invest.";
  if (/DepositAboveCap/.test(text)) return "This deposit is above the pilot limit.";
  if (/insufficient funds/i.test(text)) return "This wallet does not have enough USDC.";
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

function formatUsdc(rawAmount: bigint) {
  const whole = rawAmount / 1_000_000n, fraction = (rawAmount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function prepareNavDeposit(input: {
  connection: NavConnection; network: NavNetwork; indexId: string; owner: string; amountRaw: string;
  programId?: PublicKey; slippageBps?: number; simulate?: boolean; nowSeconds?: number;
}): Promise<NavPreparedStep> {
  const owner = new PublicKey(input.owner);
  const amount = raw(input.amountRaw, "USDC amount");
  if (amount < NAV_DEPOSIT_MINIMUM_RAW) throw new Error("The minimum is 1 USDC.");
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  const snapshot = await readNavVault(input.connection, input.indexId, programId, input.nowSeconds);
  if (!snapshot) throw new Error("This index does not have a NAV vault.");
  const { state } = snapshot;
  if (owner.equals(state.keeper)) throw new Error("The keeper wallet cannot invest.");
  if (state.maxDepositUsdc > 0n && amount > state.maxDepositUsdc) throw new Error(`The pilot limit is ${formatUsdc(state.maxDepositUsdc)} USDC per deposit.`);
  if (!snapshot.pricesFresh) throw new Error(NAV_STALE_PRICES);
  const userUsdc = await input.connection.getAccountInfo(ata(owner, state.usdcMint), "confirmed");
  if (tokenAmount(userUsdc?.data) < amount) throw new Error("This wallet does not have enough USDC.");
  const preview = previewDeposit({ usdcAmount: amount, entryFeeBps: state.entryFeeBps, nav: snapshot.nav, supply: snapshot.supply });
  if (preview.shares <= 0n) throw new Error("This amount is too small to mint a share unit.");
  const minShares = withSlippage(preview.shares, input.slippageBps ?? NAV_SLIPPAGE_BPS);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, state.shareMint), owner, state.shareMint),
    depositIx(state, owner, amount, minShares, programId),
  ];
  const compiled = await compile(input.connection, owner, instructions, await lookupTables(input.connection, state), input.simulate ?? true);
  const transaction = unsigned("nav-deposit", owner, compiled, [{ owner: owner.toBase58(), mint: state.usdcMint.toBase58(), amountRaw: amount.toString() }], [{ owner: owner.toBase58(), mint: state.shareMint.toBase58() }]);
  return {
    network: input.network,
    operationId: `nav-deposit:${input.indexId}:${transaction.messageHash.slice(0, 16)}`,
    phase: "DEPOSIT",
    requires: "user-signature",
    transactions: [transaction],
    configHash: hex(new TextEncoder().encode(`${state.address.toBase58()}:${state.entryFeeBps}:${state.bufferBps}`)),
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

export async function prepareNavWithdraw(input: {
  connection: NavConnection; network: NavNetwork; indexId: string; owner: string; shareAmountRaw: string;
  programId?: PublicKey; slippageBps?: number; simulate?: boolean; nowSeconds?: number;
}): Promise<NavPreparedStep> {
  const owner = new PublicKey(input.owner);
  const shares = raw(input.shareAmountRaw, "Share amount");
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  const snapshot = await readNavVault(input.connection, input.indexId, programId, input.nowSeconds);
  if (!snapshot) throw new Error("This index does not have a NAV vault.");
  const { state } = snapshot;
  const userShares = await input.connection.getAccountInfo(ata(owner, state.shareMint), "confirmed");
  if (tokenAmount(userShares?.data) < shares) throw new Error("This wallet does not hold that many shares.");
  const preview = previewWithdraw({ shares, nav: snapshot.nav, supply: snapshot.supply, usdcBalance: snapshot.usdcBalance, legBalances: snapshot.legBalances });
  // Stale prices: the price-independent pro-rata exit is always available.
  const path: WithdrawPath = snapshot.pricesFresh ? preview.path : "in-kind";
  const inKind = path === "in-kind"
    ? state.legs.map((leg, i) => ({ mint: leg.mint.toBase58(), amountRaw: ((snapshot.legBalances[i]! * shares) / snapshot.supply).toString() }))
    : [];
  const usdcOut = path === "usdc" ? preview.usdcOut : (snapshot.usdcBalance * shares) / snapshot.supply;
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, state.usdcMint), owner, state.usdcMint),
  ];
  if (path === "in-kind") {
    for (const leg of state.legs) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, leg.mint, leg.tokenProgram), owner, leg.mint, leg.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  instructions.push(snapshot.pricesFresh
    ? withdrawIx(state, owner, shares, withSlippage(preview.value, input.slippageBps ?? NAV_SLIPPAGE_BPS), path === "in-kind", programId)
    : withdrawInKindIx(state, owner, shares, programId));
  const compiled = await compile(input.connection, owner, instructions, await lookupTables(input.connection, state), input.simulate ?? true);
  const recipients = [{ owner: owner.toBase58(), mint: state.usdcMint.toBase58() }, ...inKind.map(item => ({ owner: owner.toBase58(), mint: item.mint }))];
  const transaction = unsigned("nav-withdraw", owner, compiled, [{ owner: owner.toBase58(), mint: state.shareMint.toBase58(), amountRaw: shares.toString() }], recipients);
  const summary = path === "usdc"
    ? `About ${formatUsdc(usdcOut)} USDC from the vault's USDC buffer.`
    : `The vault USDC buffer cannot cover this cash out${snapshot.pricesFresh ? "" : " at a fresh price"}. You receive your pro-rata share of the vault instead: ${formatUsdc(usdcOut)} USDC plus ${inKind.filter(item => item.amountRaw !== "0").length} stock tokens. This is not a USDC exit.`;
  return {
    network: input.network,
    operationId: `nav-withdraw:${input.indexId}:${transaction.messageHash.slice(0, 16)}`,
    phase: path === "usdc" ? "WITHDRAW_USDC" : "WITHDRAW_IN_KIND",
    requires: "user-signature",
    transactions: [transaction],
    configHash: hex(new TextEncoder().encode(`${state.address.toBase58()}:${state.entryFeeBps}:${state.bufferBps}`)),
    constraints: [
      { label: "Signatures", value: "One wallet approval. Shares burn and assets arrive in the same transaction." },
      { label: "Exit rule", value: "USDC from the vault buffer when it covers the share value; otherwise the exact pro-rata slice of every vault holding (stocks plus USDC)." },
    ],
    costs: { hostEntryFeeBps: state.entryFeeBps, hostExitFeeBps: 0, estimatedOnly: true },
    blockers: [],
    estimate: { returnedUsdcRaw: usdcOut.toString(), outputSummary: summary },
    navVault: { vault: state.address.toBase58(), shareMint: state.shareMint.toBase58(), path, ...(inKind.length ? { inKind } : {}) },
  };
}

export { SHARE_DECIMALS };
