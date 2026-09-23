/**
 * TS client for the NAV vault program (`programs/nav-vault`). Pure encoders/decoders/math:
 * no env, no fetch, no `@/` aliases, so tests and scripts import it directly.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const NAV_VAULT_PROGRAM_ID = new PublicKey("HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB");
export const MOCK_SWAP_PROGRAM_ID = new PublicKey("9B8ryJEpnxpebZXzYNEyLkA3Ru173yQtC3BuP7Z1ce6R");
export const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
export const USDC_LEG = 255;
export const BPS = 10_000n;
export const VIRTUAL_SHARES = 1_000_000n;
export const VIRTUAL_ASSETS = 1_000_000n;
export const SHARE_DECIMALS = 6;
export const MAX_LEGS = 25;
/** Captain defaults: 0.25% entry fee, 5% USDC buffer, 15% mark band, 10 min request timeout. */
export const DEFAULT_ENTRY_FEE_BPS = 25;
export const DEFAULT_BUFFER_BPS = 500;
export const DEFAULT_PRICE_MOVE_BPS = 1500;
export const DEFAULT_REQUEST_TIMEOUT_SECS = 600;
/** Shares are a Token-2022 mint (permanent delegate = mint authority PDA, for admin in-kind redeem). */
export const SHARE_TOKEN_PROGRAM_ID = TOKEN_2022_PROGRAM_ID;

const enc = new TextEncoder();
const disc = (namespace: string, name: string) => Buffer.from(sha256(enc.encode(`${namespace}:${name}`)).subarray(0, 8));
export const IX = {
  initVault: disc("global", "init_vault"),
  setKeeper: disc("global", "set_keeper"),
  setLookupTable: disc("global", "set_lookup_table"),
  setMaxDeposit: disc("global", "set_max_deposit"),
  setPaused: disc("global", "set_paused"),
  adminSetPrices: disc("global", "admin_set_prices"),
  updatePrices: disc("global", "update_prices"),
  deposit: disc("global", "deposit"),
  withdraw: disc("global", "withdraw"),
  requestWithdraw: disc("global", "request_withdraw"),
  adminRedeemInKind: disc("global", "admin_redeem_in_kind"),
  claimInKind: disc("global", "claim_in_kind"),
  settleRequest: disc("global", "settle_request"),
  crossRequestLeg: disc("global", "cross_request_leg"),
  keeperSwap: disc("global", "keeper_swap"),
  fulfillSwap: disc("global", "fulfill_swap"),
} as const;
export const VAULT_ACCOUNT_DISCRIMINATOR = disc("account", "Vault");
export const REQUEST_ACCOUNT_DISCRIMINATOR = disc("account", "WithdrawRequest");
export const MOCK_SWAP_DISCRIMINATOR = disc("global", "swap");

// ---------- PDAs ----------

export function indexSeed(indexId: string): Buffer {
  const bytes = enc.encode(indexId);
  if (!bytes.length || bytes.length > 64) throw new Error("Index id must be 1-64 bytes.");
  return Buffer.from(sha256(bytes));
}
export function vaultPda(indexId: string, programId = NAV_VAULT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("nav_vault"), indexSeed(indexId)], programId)[0];
}
export function authorityPda(vault: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("authority"), vault.toBuffer()], programId)[0];
}
export function mintAuthorityPda(vault: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), vault.toBuffer()], programId)[0];
}
export function shareMintPda(vault: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], programId)[0];
}
export function requestPda(vault: PublicKey, owner: PublicKey, nonce: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  const n = Buffer.alloc(8); n.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync([Buffer.from("request"), vault.toBuffer(), owner.toBuffer(), n], programId)[0];
}
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}
export function shareAta(owner: PublicKey, shareMint: PublicKey) {
  return ata(owner, shareMint, SHARE_TOKEN_PROGRAM_ID);
}

// ---------- borsh ----------

class Writer {
  private parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v])); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v: bigint | number | string) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  bytes(v: Uint8Array) { this.parts.push(Buffer.from(v)); return this; }
  vecBytes(v: Uint8Array) { return this.u32(v.length).bytes(v); }
  string(v: string) { return this.vecBytes(enc.encode(v)); }
  key(v: PublicKey) { return this.bytes(v.toBuffer()); }
  done(prefix: Buffer) { return Buffer.concat([prefix, ...this.parts]); }
}
class Reader {
  o = 8;
  private b: Buffer;
  constructor(b: Buffer) { this.b = b; }
  key() { const k = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return k; }
  raw(n: number) { const v = Buffer.from(this.b.subarray(this.o, this.o + n)); this.o += n; return v; }
  u8() { return this.b[this.o++]!; }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  string() { const n = this.u32(); return new TextDecoder().decode(this.raw(n)); }
}

// ---------- state ----------

export type NavLeg = { mint: PublicKey; account: PublicKey; tokenProgram: PublicKey; decimals: number; weightBps: number; price: bigint; reserved: bigint; cachedBalance: bigint };
export type NavVaultState = {
  address: PublicKey;
  admin: PublicKey;
  keeper: PublicKey;
  indexSeed: Buffer;
  indexId: string;
  shareMint: PublicKey;
  usdcMint: PublicKey;
  usdcAccount: PublicKey;
  feeAccount: PublicKey;
  lookupTable: PublicKey | null;
  maxPriceAgeSecs: number;
  maxSlippageBps: number;
  maxPriceMoveBps: number;
  entryFeeBps: number;
  bufferBps: number;
  /** Per-deposit USDC cap in raw units; 0n = none. */
  maxDepositUsdc: bigint;
  requestTimeoutSecs: number;
  paused: boolean;
  pricesUpdatedAt: number;
  pricesUpdatedSlot: bigint;
  reservedUsdc: bigint;
  bump: number;
  authorityBump: number;
  mintAuthorityBump: number;
  legs: NavLeg[];
};

export function decodeVault(address: PublicKey, data: Uint8Array): NavVaultState {
  const b = Buffer.from(data);
  if (b.length < 8 || !b.subarray(0, 8).equals(VAULT_ACCOUNT_DISCRIMINATOR)) throw new Error("Not a NAV vault account.");
  const r = new Reader(b);
  const admin = r.key(), keeper = r.key(), seed = r.raw(32), indexId = r.string();
  const shareMint = r.key(), usdcMint = r.key(), usdcAccount = r.key(), feeAccount = r.key(), lut = r.key();
  const maxPriceAgeSecs = r.u32(), maxSlippageBps = r.u16(), maxPriceMoveBps = r.u16(), entryFeeBps = r.u16(), bufferBps = r.u16();
  const maxDepositUsdc = r.u64(), requestTimeoutSecs = r.u32(), paused = r.bool();
  const pricesUpdatedAt = Number(r.i64()), pricesUpdatedSlot = r.u64(), reservedUsdc = r.u64();
  const bump = r.u8(), authorityBump = r.u8(), mintAuthorityBump = r.u8();
  const n = r.u32();
  const legs: NavLeg[] = [];
  for (let i = 0; i < n; i++) legs.push({ mint: r.key(), account: r.key(), tokenProgram: r.key(), decimals: r.u8(), weightBps: r.u16(), price: r.u64(), reserved: r.u64(), cachedBalance: r.u64() });
  return {
    address, admin, keeper, indexSeed: seed, indexId, shareMint, usdcMint, usdcAccount, feeAccount, lookupTable: lut.equals(PublicKey.default) ? null : lut,
    maxPriceAgeSecs, maxSlippageBps, maxPriceMoveBps, entryFeeBps, bufferBps, maxDepositUsdc, requestTimeoutSecs, paused,
    pricesUpdatedAt, pricesUpdatedSlot, reservedUsdc, bump, authorityBump, mintAuthorityBump, legs,
  };
}

export type NavRequest = {
  address: PublicKey; vault: PublicKey; owner: PublicKey; nonce: bigint; shares: bigint; minUsdc: bigint;
  createdAt: number; claimableAt: number; usdcOwed: bigint; valueAtRequest: bigint; adminForced: boolean; bump: number; legAmounts: bigint[];
};
export function decodeRequest(address: PublicKey, data: Uint8Array): NavRequest {
  const b = Buffer.from(data);
  if (b.length < 8 || !b.subarray(0, 8).equals(REQUEST_ACCOUNT_DISCRIMINATOR)) throw new Error("Not a NAV withdraw request.");
  const r = new Reader(b);
  const vault = r.key(), owner = r.key(), nonce = r.u64(), shares = r.u64(), minUsdc = r.u64();
  const createdAt = Number(r.i64()), claimableAt = Number(r.i64()), usdcOwed = r.u64(), valueAtRequest = r.u64(), adminForced = r.bool(), bump = r.u8();
  const n = r.u32();
  const legAmounts: bigint[] = [];
  for (let i = 0; i < n; i++) legAmounts.push(r.u64());
  return { address, vault, owner, nonce, shares, minUsdc, createdAt, claimableAt, usdcOwed, valueAtRequest, adminForced, bump, legAmounts };
}

/** Raw SPL token-account amount (Token and Token-2022 share the base layout). */
export function tokenAmount(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < 165) return 0n;
  return Buffer.from(data).readBigUInt64LE(64);
}

// ---------- math (mirrors the program exactly) ----------

const free = (balance: bigint, reserved: bigint) => balance > reserved ? balance - reserved : 0n;
export function legValue(leg: Pick<NavLeg, "price" | "decimals">, amount: bigint): bigint {
  return (amount * leg.price) / 10n ** BigInt(leg.decimals);
}
/** NAV over FREE balances (reserved request slices excluded). */
export function computeNav(vault: Pick<NavVaultState, "legs" | "reservedUsdc">, usdcBalance: bigint, legBalances: readonly bigint[]): bigint {
  return vault.legs.reduce((sum, leg, i) => sum + legValue(leg, free(legBalances[i] ?? 0n, leg.reserved)), free(usdcBalance, vault.reservedUsdc));
}
export function freeUsdc(vault: Pick<NavVaultState, "reservedUsdc">, usdcBalance: bigint) { return free(usdcBalance, vault.reservedUsdc); }
export function entryFee(usdcAmount: bigint, feeBps: number): bigint {
  return (usdcAmount * BigInt(feeBps) + BPS - 1n) / BPS;
}
export function previewDeposit(input: { usdcAmount: bigint; entryFeeBps: number; nav: bigint; supply: bigint }) {
  const fee = entryFee(input.usdcAmount, input.entryFeeBps);
  const net = input.usdcAmount - fee;
  const shares = (net * (input.supply + VIRTUAL_SHARES)) / (input.nav + VIRTUAL_ASSETS);
  return { fee, net, shares };
}
export type WithdrawPath = "usdc" | "request" | "in-kind";
/** Instant USDC when the free buffer covers the value; otherwise a request carving the pro-rata slice. */
export function previewWithdraw(input: { vault: Pick<NavVaultState, "legs" | "reservedUsdc">; shares: bigint; nav: bigint; supply: bigint; usdcBalance: bigint; legBalances: readonly bigint[] }) {
  const value = (input.shares * (input.nav + VIRTUAL_ASSETS)) / (input.supply + VIRTUAL_SHARES);
  const freeUsdcNow = free(input.usdcBalance, input.vault.reservedUsdc);
  const slice = {
    usdc: (freeUsdcNow * input.shares) / input.supply,
    legs: input.vault.legs.map((leg, i) => (free(input.legBalances[i] ?? 0n, leg.reserved) * input.shares) / input.supply),
  };
  return { instant: freeUsdcNow >= value, value, slice };
}
export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * (BPS - BigInt(bps))) / BPS;
}

// ---------- instructions ----------

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
const legMetas = (vault: Pick<NavVaultState, "legs">, writable = false) => vault.legs.map(leg => meta(leg.account, writable));

export type InitVaultInput = {
  admin: PublicKey;
  indexId: string;
  keeper: PublicKey;
  usdcMint: PublicKey;
  feeAccount: PublicKey;
  maxPriceAgeSecs: number;
  maxSlippageBps: number;
  maxPriceMoveBps?: number;
  entryFeeBps?: number;
  bufferBps?: number;
  /** Per-deposit USDC cap in raw units (0 = none). */
  maxDepositUsdc?: bigint;
  requestTimeoutSecs?: number;
  legs: { mint: PublicKey; tokenProgram: PublicKey; weightBps: number }[];
  programId?: PublicKey;
};

/** Vault USDC + leg accounts are ATAs of the authority PDA; create them (idempotently) before `initVault`. */
export function vaultTokenAccounts(indexId: string, usdcMint: PublicKey, legs: readonly { mint: PublicKey; tokenProgram: PublicKey }[], programId = NAV_VAULT_PROGRAM_ID) {
  const vault = vaultPda(indexId, programId);
  const authority = authorityPda(vault, programId);
  return { vault, authority, usdc: ata(authority, usdcMint), legs: legs.map(leg => ata(authority, leg.mint, leg.tokenProgram)) };
}

export function initVaultIx(input: InitVaultInput): TransactionInstruction {
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  if (input.legs.length < 1 || input.legs.length > MAX_LEGS) throw new Error(`A NAV vault holds 1-${MAX_LEGS} legs.`);
  const accounts = vaultTokenAccounts(input.indexId, input.usdcMint, input.legs, programId);
  const w = new Writer().bytes(indexSeed(input.indexId)).string(input.indexId).key(input.keeper)
    .u32(input.maxPriceAgeSecs).u16(input.maxSlippageBps).u16(input.maxPriceMoveBps ?? DEFAULT_PRICE_MOVE_BPS)
    .u16(input.entryFeeBps ?? DEFAULT_ENTRY_FEE_BPS).u16(input.bufferBps ?? DEFAULT_BUFFER_BPS)
    .u64(input.maxDepositUsdc ?? 0n).u32(input.requestTimeoutSecs ?? DEFAULT_REQUEST_TIMEOUT_SECS).u32(input.legs.length);
  for (const leg of input.legs) w.u16(leg.weightBps);
  return new TransactionInstruction({
    programId,
    data: w.done(IX.initVault),
    keys: [
      meta(input.admin, true, true), meta(accounts.vault, true), meta(accounts.authority), meta(mintAuthorityPda(accounts.vault, programId)),
      meta(shareMintPda(accounts.vault, programId), true), meta(input.usdcMint), meta(accounts.usdc), meta(input.feeAccount),
      meta(TOKEN_PROGRAM_ID), meta(SHARE_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
      ...input.legs.flatMap((leg, i) => [meta(leg.mint), meta(accounts.legs[i]!)]),
    ],
  });
}

const adminIx = (programId: PublicKey, vault: Pick<NavVaultState, "address">, admin: PublicKey, data: Buffer) =>
  new TransactionInstruction({ programId, data, keys: [meta(admin, false, true), meta(vault.address, true)] });
export function setKeeperIx(vault: Pick<NavVaultState, "address">, admin: PublicKey, keeper: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return adminIx(programId, vault, admin, new Writer().key(keeper).done(IX.setKeeper));
}
export function setMaxDepositIx(vault: Pick<NavVaultState, "address">, admin: PublicKey, maxDepositUsdc: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return adminIx(programId, vault, admin, new Writer().u64(maxDepositUsdc).done(IX.setMaxDeposit));
}
export function setLookupTableIx(vault: Pick<NavVaultState, "address">, admin: PublicKey, lookupTable: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return adminIx(programId, vault, admin, new Writer().key(lookupTable).done(IX.setLookupTable));
}
export function setPausedIx(vault: Pick<NavVaultState, "address">, admin: PublicKey, paused: boolean, programId = NAV_VAULT_PROGRAM_ID) {
  return adminIx(programId, vault, admin, new Writer().bool(paused).done(IX.setPaused));
}

/** Every static vault account a one-signature deposit/exit/keeper step needs; the admin puts these in the vault LUT. */
export function vaultLookupAddresses(vault: NavVaultState, programId = NAV_VAULT_PROGRAM_ID): PublicKey[] {
  const keys = [
    vault.address, authorityPda(vault.address, programId), mintAuthorityPda(vault.address, programId), vault.shareMint, vault.usdcMint,
    vault.usdcAccount, vault.feeAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, programId,
    ...vault.legs.flatMap(leg => [leg.account, leg.mint]),
  ];
  const seen = new Set<string>();
  return keys.filter(key => !seen.has(key.toBase58()) && seen.add(key.toBase58()));
}

const pricesData = (prefix: Buffer, prices: readonly bigint[]) => { const w = new Writer().u32(prices.length); for (const p of prices) w.u64(p); return w.done(prefix); };
/** Keeper marks; the leg accounts refresh the on-chain balance cache used by the buffer rule. */
export function updatePricesIx(vault: Pick<NavVaultState, "address" | "legs">, keeper: PublicKey, prices: readonly bigint[], programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: pricesData(IX.updatePrices, prices), keys: [meta(keeper, false, true), meta(vault.address, true), ...legMetas(vault)] });
}
/** Admin override of the per-update mark band. */
export function adminSetPricesIx(vault: Pick<NavVaultState, "address" | "legs">, admin: PublicKey, prices: readonly bigint[], programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: pricesData(IX.adminSetPrices, prices), keys: [meta(admin, false, true), meta(vault.address, true), ...legMetas(vault)] });
}

export function depositIx(vault: NavVaultState, user: PublicKey, usdcAmount: bigint, minShares: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(usdcAmount).u64(minShares).done(IX.deposit),
    keys: [
      meta(user, false, true), meta(vault.address), meta(mintAuthorityPda(vault.address, programId)), meta(vault.shareMint, true),
      meta(vault.usdcMint), meta(vault.usdcAccount, true), meta(ata(user, vault.usdcMint), true), meta(shareAta(user, vault.shareMint), true),
      meta(vault.feeAccount, true), meta(TOKEN_PROGRAM_ID), meta(SHARE_TOKEN_PROGRAM_ID),
      ...legMetas(vault),
    ],
  });
}

/** Instant USDC from the free buffer (fails with `UsdcBufferShort` if it cannot cover the value). */
export function withdrawIx(vault: NavVaultState, user: PublicKey, shares: bigint, minUsdc: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(shares).u64(minUsdc).done(IX.withdraw),
    keys: [
      meta(user, false, true), meta(vault.address), meta(authorityPda(vault.address, programId)), meta(vault.shareMint, true),
      meta(vault.usdcMint), meta(vault.usdcAccount, true), meta(ata(user, vault.usdcMint), true), meta(shareAta(user, vault.shareMint), true),
      meta(TOKEN_PROGRAM_ID), meta(SHARE_TOKEN_PROGRAM_ID),
      ...legMetas(vault),
    ],
  });
}

export function requestWithdrawIx(vault: NavVaultState, user: PublicKey, input: { shares: bigint; minUsdc: bigint; nonce: bigint; inKindNow: boolean }, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(input.shares).u64(input.minUsdc).u64(input.nonce).bool(input.inKindNow).done(IX.requestWithdraw),
    keys: [
      meta(user, true, true), meta(vault.address, true), meta(vault.shareMint, true), meta(shareAta(user, vault.shareMint), true),
      meta(vault.usdcAccount), meta(requestPda(vault.address, user, input.nonce, programId), true), meta(SHARE_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
      ...legMetas(vault),
    ],
  });
}

export function adminRedeemInKindIx(vault: NavVaultState, admin: PublicKey, holder: PublicKey, shares: bigint, nonce: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(shares).u64(nonce).done(IX.adminRedeemInKind),
    keys: [
      meta(admin, true, true), meta(vault.address, true), meta(holder), meta(shareAta(holder, vault.shareMint), true),
      meta(mintAuthorityPda(vault.address, programId)), meta(vault.shareMint, true), meta(vault.usdcAccount),
      meta(requestPda(vault.address, holder, nonce, programId), true), meta(SHARE_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
      ...legMetas(vault),
    ],
  });
}

const settleKeys = (vault: NavVaultState, caller: PublicKey, request: Pick<NavRequest, "address" | "owner">, programId: PublicKey) => [
  meta(caller, false, true), meta(vault.address, true), meta(authorityPda(vault.address, programId)), meta(request.address, true),
  meta(request.owner, true), meta(vault.usdcMint), meta(vault.usdcAccount, true), meta(ata(request.owner, vault.usdcMint), true), meta(TOKEN_PROGRAM_ID),
];
/** Max legs per claim transaction (9 fixed + 4 per leg <= 64 accounts). */
export const CLAIM_LEGS_PER_TX = 13;
export function claimInKindIx(vault: NavVaultState, caller: PublicKey, request: Pick<NavRequest, "address" | "owner">, legs: readonly number[], programId = NAV_VAULT_PROGRAM_ID) {
  const w = new Writer().u32(legs.length); for (const i of legs) w.u8(i);
  return new TransactionInstruction({
    programId,
    data: w.done(IX.claimInKind),
    keys: [
      ...settleKeys(vault, caller, request, programId),
      ...legs.flatMap(i => { const leg = vault.legs[i]!; return [meta(leg.account, true), meta(leg.mint), meta(ata(request.owner, leg.mint, leg.tokenProgram), true), meta(leg.tokenProgram)]; }),
    ],
  });
}
export function settleRequestIx(vault: NavVaultState, caller: PublicKey, request: Pick<NavRequest, "address" | "owner">, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: Buffer.from(IX.settleRequest), keys: settleKeys(vault, caller, request, programId) });
}
export function crossRequestLegIx(vault: NavVaultState, keeper: PublicKey, request: PublicKey, leg: number, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().u8(leg).done(IX.crossRequestLeg), keys: [meta(keeper, false, true), meta(vault.address, true), meta(request, true), meta(vault.usdcAccount)] });
}

const swapData = (prefix: Buffer, input: { inLeg: number; outLeg: number; amountIn: bigint; minOut: bigint; swap: TransactionInstruction }) =>
  new Writer().u8(input.inLeg).u8(input.outLeg).u64(input.amountIn).u64(input.minOut).vecBytes(input.swap.data).done(prefix);
const swapKeys = (swap: TransactionInstruction, authority: PublicKey) =>
  // The authority PDA cannot sign at the top level; the program re-adds its signature in the CPI.
  swap.keys.map(k => meta(k.pubkey, k.isWritable, k.pubkey.equals(authority) ? false : k.isSigner));

/** Wrap one venue swap instruction (built with taker = authority PDA); the venue accounts must include the in/out vault accounts. */
export function keeperSwapIx(input: { vault: NavVaultState; keeper: PublicKey; inLeg: number; outLeg: number; amountIn: bigint; minOut: bigint; swap: TransactionInstruction; programId?: PublicKey }) {
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  const authority = authorityPda(input.vault.address, programId);
  return new TransactionInstruction({
    programId,
    data: swapData(IX.keeperSwap, input),
    keys: [meta(input.keeper, false, true), meta(input.vault.address, true), meta(authority), meta(input.swap.programId), ...swapKeys(input.swap, authority)],
  });
}
/** Sell a request's reserved leg slice into USDC credited to the request. */
export function fulfillSwapIx(input: { vault: NavVaultState; keeper: PublicKey; request: PublicKey; inLeg: number; amountIn: bigint; minOut: bigint; swap: TransactionInstruction; programId?: PublicKey }) {
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  const authority = authorityPda(input.vault.address, programId);
  return new TransactionInstruction({
    programId,
    data: swapData(IX.fulfillSwap, { ...input, outLeg: USDC_LEG }),
    keys: [meta(input.keeper, false, true), meta(input.vault.address, true), meta(authority), meta(input.request, true), meta(input.swap.programId), ...swapKeys(input.swap, authority)],
  });
}

export function legIndex(vault: Pick<NavVaultState, "legs" | "usdcMint">, mint: PublicKey): number {
  if (mint.equals(vault.usdcMint)) return USDC_LEG;
  const i = vault.legs.findIndex(leg => leg.mint.equals(mint));
  if (i < 0) throw new Error(`Mint ${mint.toBase58()} is not a vault leg.`);
  return i;
}
export function legAccount(vault: NavVaultState, leg: number): PublicKey {
  return leg === USDC_LEG ? vault.usdcAccount : vault.legs[leg]!.account;
}
export function legMint(vault: NavVaultState, leg: number): PublicKey {
  return leg === USDC_LEG ? vault.usdcMint : vault.legs[leg]!.mint;
}
export function legTokenProgram(vault: NavVaultState, leg: number): PublicKey {
  return leg === USDC_LEG ? TOKEN_PROGRAM_ID : vault.legs[leg]!.tokenProgram;
}

// ---------- mock swap (devnet/test venue only) ----------

export function mockPoolPda(baseMint: PublicKey, quoteMint: PublicKey, programId = MOCK_SWAP_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()], programId)[0];
}
export function mockInitPoolIx(payer: PublicKey, baseMint: PublicKey, quoteMint: PublicKey, price: bigint, programId = MOCK_SWAP_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(price).done(Buffer.from([0])),
    keys: [meta(payer, true, true), meta(mockPoolPda(baseMint, quoteMint, programId), true), meta(baseMint), meta(quoteMint), meta(SystemProgram.programId)],
  });
}
export function mockSetPriceIx(admin: PublicKey, pool: PublicKey, price: bigint, programId = MOCK_SWAP_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().u64(price).done(Buffer.from([1])), keys: [meta(admin, false, true), meta(pool, true)] });
}
/** Swap between `user` token accounts and the pool reserves (ATAs of the pool PDA). */
export function mockSwapIx(input: {
  user: PublicKey; baseMint: PublicKey; quoteMint: PublicKey; inMint: PublicKey; outMint: PublicKey;
  userSrc: PublicKey; userDst: PublicKey; amountIn: bigint; minOut: bigint;
  inTokenProgram?: PublicKey; outTokenProgram?: PublicKey; programId?: PublicKey;
}) {
  const programId = input.programId ?? MOCK_SWAP_PROGRAM_ID;
  const pool = mockPoolPda(input.baseMint, input.quoteMint, programId);
  const inProgram = input.inTokenProgram ?? TOKEN_PROGRAM_ID, outProgram = input.outTokenProgram ?? TOKEN_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(input.amountIn).u64(input.minOut).done(MOCK_SWAP_DISCRIMINATOR),
    keys: [
      meta(input.user, false, true), meta(pool), meta(input.userSrc, true), meta(input.userDst, true),
      meta(ata(pool, input.outMint, outProgram), true), meta(ata(pool, input.inMint, inProgram), true),
      meta(input.inMint), meta(input.outMint), meta(inProgram), meta(outProgram),
    ],
  });
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };
