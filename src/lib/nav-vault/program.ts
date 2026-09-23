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
/** Captain defaults: 0.25% entry fee, 5% USDC exit buffer. */
export const DEFAULT_ENTRY_FEE_BPS = 25;
export const DEFAULT_BUFFER_BPS = 500;

const enc = new TextEncoder();
const disc = (namespace: string, name: string) => Buffer.from(sha256(enc.encode(`${namespace}:${name}`)).subarray(0, 8));
export const IX = {
  initVault: disc("global", "init_vault"),
  setKeeper: disc("global", "set_keeper"),
  setLookupTable: disc("global", "set_lookup_table"),
  setMaxDeposit: disc("global", "set_max_deposit"),
  updatePrices: disc("global", "update_prices"),
  deposit: disc("global", "deposit"),
  withdraw: disc("global", "withdraw"),
  withdrawInKind: disc("global", "withdraw_in_kind"),
  keeperSwap: disc("global", "keeper_swap"),
} as const;
export const VAULT_ACCOUNT_DISCRIMINATOR = disc("account", "Vault");
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
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

// ---------- borsh ----------

class Writer {
  private parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v])); return this; }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v: bigint | number | string) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  bytes(v: Uint8Array) { this.parts.push(Buffer.from(v)); return this; }
  vecBytes(v: Uint8Array) { return this.u32(v.length).bytes(v); }
  string(v: string) { return this.vecBytes(enc.encode(v)); }
  key(v: PublicKey) { return this.bytes(v.toBuffer()); }
  done(prefix: Buffer) { return Buffer.concat([prefix, ...this.parts]); }
}

// ---------- state ----------

export type NavLeg = { mint: PublicKey; account: PublicKey; tokenProgram: PublicKey; decimals: number; weightBps: number; price: bigint };
export type NavVaultState = {
  address: PublicKey;
  admin: PublicKey;
  keeper: PublicKey;
  indexSeed: Buffer;
  indexId: string;
  shareMint: PublicKey;
  usdcMint: PublicKey;
  usdcAccount: PublicKey;
  maxPriceAgeSecs: number;
  maxSlippageBps: number;
  pricesUpdatedAt: number;
  pricesUpdatedSlot: bigint;
  entryFeeBps: number;
  bufferBps: number;
  feeAccount: PublicKey;
  lookupTable: PublicKey | null;
  /** Per-deposit USDC cap in raw units; 0n = none. */
  maxDepositUsdc: bigint;
  bump: number;
  authorityBump: number;
  mintAuthorityBump: number;
  legs: NavLeg[];
};

export function decodeVault(address: PublicKey, data: Uint8Array): NavVaultState {
  const b = Buffer.from(data);
  if (b.length < 8 || !b.subarray(0, 8).equals(VAULT_ACCOUNT_DISCRIMINATOR)) throw new Error("Not a NAV vault account.");
  let o = 8;
  const key = () => { const k = new PublicKey(b.subarray(o, o + 32)); o += 32; return k; };
  const u8 = () => b[o++]!;
  const u16 = () => { const v = b.readUInt16LE(o); o += 2; return v; };
  const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
  const i64 = () => { const v = b.readBigInt64LE(o); o += 8; return v; };
  const admin = key(), keeper = key();
  const seed = Buffer.from(b.subarray(o, o + 32)); o += 32;
  const idLen = u32(); const indexId = new TextDecoder().decode(b.subarray(o, o + idLen)); o += idLen;
  const shareMint = key(), usdcMint = key(), usdcAccount = key();
  const maxPriceAgeSecs = u32(), maxSlippageBps = u16();
  const pricesUpdatedAt = Number(i64()), pricesUpdatedSlot = u64();
  const entryFeeBps = u16(), bufferBps = u16();
  const feeAccount = key();
  const lut = key();
  const lookupTable = lut.equals(PublicKey.default) ? null : lut;
  const maxDepositUsdc = u64();
  const bump = u8(), authorityBump = u8(), mintAuthorityBump = u8();
  const n = u32();
  const legs: NavLeg[] = [];
  for (let i = 0; i < n; i++) legs.push({ mint: key(), account: key(), tokenProgram: key(), decimals: u8(), weightBps: u16(), price: u64() });
  return { address, admin, keeper, indexSeed: seed, indexId, shareMint, usdcMint, usdcAccount, maxPriceAgeSecs, maxSlippageBps, pricesUpdatedAt, pricesUpdatedSlot, entryFeeBps, bufferBps, feeAccount, lookupTable, maxDepositUsdc, bump, authorityBump, mintAuthorityBump, legs };
}

/** Raw SPL token-account amount (Token and Token-2022 share the base layout). */
export function tokenAmount(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < 165) return 0n;
  return Buffer.from(data).readBigUInt64LE(64);
}

// ---------- math (mirrors the program exactly) ----------

export function legValue(leg: Pick<NavLeg, "price" | "decimals">, amount: bigint): bigint {
  return (amount * leg.price) / 10n ** BigInt(leg.decimals);
}
export function computeNav(vault: Pick<NavVaultState, "legs">, usdcBalance: bigint, legBalances: readonly bigint[]): bigint {
  return vault.legs.reduce((sum, leg, i) => sum + legValue(leg, legBalances[i] ?? 0n), usdcBalance);
}
export function entryFee(usdcAmount: bigint, feeBps: number): bigint {
  return (usdcAmount * BigInt(feeBps) + BPS - 1n) / BPS;
}
export function previewDeposit(input: { usdcAmount: bigint; entryFeeBps: number; nav: bigint; supply: bigint }) {
  const fee = entryFee(input.usdcAmount, input.entryFeeBps);
  const net = input.usdcAmount - fee;
  const shares = (net * (input.supply + VIRTUAL_SHARES)) / (input.nav + VIRTUAL_ASSETS);
  return { fee, net, shares };
}
export type WithdrawPath = "usdc" | "in-kind";
export function previewWithdraw(input: { shares: bigint; nav: bigint; supply: bigint; usdcBalance: bigint; legBalances: readonly bigint[] }) {
  const value = (input.shares * (input.nav + VIRTUAL_ASSETS)) / (input.supply + VIRTUAL_SHARES);
  if (input.usdcBalance >= value) return { path: "usdc" as WithdrawPath, value, usdcOut: value, legOut: input.legBalances.map(() => 0n) };
  return {
    path: "in-kind" as WithdrawPath,
    value,
    usdcOut: (input.usdcBalance * input.shares) / input.supply,
    legOut: input.legBalances.map(balance => (balance * input.shares) / input.supply),
  };
}
export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * (BPS - BigInt(bps))) / BPS;
}

// ---------- instructions ----------

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });

export type InitVaultInput = {
  admin: PublicKey;
  indexId: string;
  keeper: PublicKey;
  usdcMint: PublicKey;
  feeAccount: PublicKey;
  maxPriceAgeSecs: number;
  maxSlippageBps: number;
  entryFeeBps?: number;
  bufferBps?: number;
  /** Per-deposit USDC cap in raw units (0 = none). */
  maxDepositUsdc?: bigint;
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
  const accounts = vaultTokenAccounts(input.indexId, input.usdcMint, input.legs, programId);
  const w = new Writer().bytes(indexSeed(input.indexId)).string(input.indexId).key(input.keeper)
    .u32(input.maxPriceAgeSecs).u16(input.maxSlippageBps).u16(input.entryFeeBps ?? DEFAULT_ENTRY_FEE_BPS).u16(input.bufferBps ?? DEFAULT_BUFFER_BPS)
    .u64(input.maxDepositUsdc ?? 0n).u32(input.legs.length);
  for (const leg of input.legs) w.u16(leg.weightBps);
  return new TransactionInstruction({
    programId,
    data: w.done(IX.initVault),
    keys: [
      meta(input.admin, true, true), meta(accounts.vault, true), meta(accounts.authority), meta(mintAuthorityPda(accounts.vault, programId)),
      meta(shareMintPda(accounts.vault, programId), true), meta(input.usdcMint), meta(accounts.usdc), meta(input.feeAccount),
      meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
      ...input.legs.flatMap((leg, i) => [meta(leg.mint), meta(accounts.legs[i]!)]),
    ],
  });
}

export function setKeeperIx(vault: NavVaultState, admin: PublicKey, keeper: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().key(keeper).done(IX.setKeeper), keys: [meta(admin, false, true), meta(vault.address, true)] });
}

export function setMaxDepositIx(vault: Pick<NavVaultState, "address">, admin: PublicKey, maxDepositUsdc: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().u64(maxDepositUsdc).done(IX.setMaxDeposit), keys: [meta(admin, false, true), meta(vault.address, true)] });
}

export function setLookupTableIx(vault: Pick<NavVaultState, "address">, admin: PublicKey, lookupTable: PublicKey, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().key(lookupTable).done(IX.setLookupTable), keys: [meta(admin, false, true), meta(vault.address, true)] });
}

/** Every static vault account a one-signature deposit/exit needs; the admin puts these in the vault LUT. */
export function vaultLookupAddresses(vault: NavVaultState, programId = NAV_VAULT_PROGRAM_ID): PublicKey[] {
  const keys = [
    vault.address, authorityPda(vault.address, programId), mintAuthorityPda(vault.address, programId), vault.shareMint, vault.usdcMint,
    vault.usdcAccount, vault.feeAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
    ...vault.legs.flatMap(leg => [leg.account, leg.mint]),
  ];
  const seen = new Set<string>();
  return keys.filter(key => !seen.has(key.toBase58()) && seen.add(key.toBase58()));
}

export function updatePricesIx(vault: Pick<NavVaultState, "address">, keeper: PublicKey, prices: readonly bigint[], programId = NAV_VAULT_PROGRAM_ID) {
  const w = new Writer().u32(prices.length);
  for (const price of prices) w.u64(price);
  return new TransactionInstruction({ programId, data: w.done(IX.updatePrices), keys: [meta(keeper, false, true), meta(vault.address, true)] });
}

export function depositIx(vault: NavVaultState, user: PublicKey, usdcAmount: bigint, minShares: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    data: new Writer().u64(usdcAmount).u64(minShares).done(IX.deposit),
    keys: [
      meta(user, true, true), meta(vault.address), meta(mintAuthorityPda(vault.address, programId)), meta(vault.shareMint, true),
      meta(vault.usdcMint), meta(vault.usdcAccount, true), meta(ata(user, vault.usdcMint), true), meta(ata(user, vault.shareMint), true),
      meta(vault.feeAccount, true), meta(TOKEN_PROGRAM_ID),
      ...vault.legs.map(leg => meta(leg.account)),
    ],
  });
}

function withdrawKeys(vault: NavVaultState, user: PublicKey, inKind: boolean, programId: PublicKey): AccountMeta[] {
  return [
    meta(user, true, true), meta(vault.address), meta(authorityPda(vault.address, programId)), meta(vault.shareMint, true),
    meta(vault.usdcMint), meta(vault.usdcAccount, true), meta(ata(user, vault.usdcMint), true), meta(ata(user, vault.shareMint), true),
    meta(TOKEN_PROGRAM_ID),
    ...vault.legs.map(leg => meta(leg.account, true)),
    ...(inKind ? vault.legs.flatMap(leg => [meta(leg.mint), meta(ata(user, leg.mint, leg.tokenProgram), true), meta(leg.tokenProgram)]) : []),
  ];
}

/** `includeInKind` adds the user's leg accounts so the program can fall back to the pro-rata basket. */
export function withdrawIx(vault: NavVaultState, user: PublicKey, shares: bigint, minUsdc: bigint, includeInKind: boolean, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().u64(shares).u64(minUsdc).done(IX.withdraw), keys: withdrawKeys(vault, user, includeInKind, programId) });
}

export function withdrawInKindIx(vault: NavVaultState, user: PublicKey, shares: bigint, programId = NAV_VAULT_PROGRAM_ID) {
  return new TransactionInstruction({ programId, data: new Writer().u64(shares).done(IX.withdrawInKind), keys: withdrawKeys(vault, user, true, programId) });
}

/** Wrap one venue swap instruction (built with taker = authority PDA) so the vault PDA signs it via CPI. */
export function keeperSwapIx(input: {
  vault: NavVaultState;
  keeper: PublicKey;
  inLeg: number;
  outLeg: number;
  amountIn: bigint;
  minOut: bigint;
  swap: TransactionInstruction;
  programId?: PublicKey;
}) {
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  const authority = authorityPda(input.vault.address, programId);
  return new TransactionInstruction({
    programId,
    data: new Writer().u8(input.inLeg).u8(input.outLeg).u64(input.amountIn).u64(input.minOut).vecBytes(input.swap.data).done(IX.keeperSwap),
    keys: [
      meta(input.keeper, false, true), meta(input.vault.address), meta(authority), meta(input.vault.shareMint),
      meta(input.vault.usdcAccount, true), meta(input.swap.programId),
      ...input.vault.legs.map(leg => meta(leg.account, true)),
      // The authority PDA cannot sign at the top level; the program re-adds its signature in the CPI.
      ...input.swap.keys.map(k => meta(k.pubkey, k.isWritable, k.pubkey.equals(authority) ? false : k.isSigner)),
    ],
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
