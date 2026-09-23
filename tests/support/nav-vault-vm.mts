import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction, createMintToInstruction,
} from "@solana/spl-token";
import {
  JUPITER_V6_PROGRAM_ID, MOCK_SWAP_PROGRAM_ID, NAV_VAULT_DEVNET_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, ata, setDefaultProgramId, decodeVault, initVaultIx, mockInitPoolIx,
  mockPoolPda, setLookupTableIx, tokenAmount, vaultLookupAddresses, vaultPda, vaultTokenAccounts, type NavVaultState,
} from "../../src/lib/nav-vault/program.ts";
import type { NavConnection } from "../../src/lib/nav-vault/prepare.ts";
import bs58 from "bs58";

globalThis.fetch = async () => { throw new Error("OFFLINE NAV VAULT VM: network forbidden"); };

const bin = new URL("../../programs/bin/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", bin), "utf8")) as Record<string, string>;
export function programBinary(name: "nav_vault.so" | "nav_vault_devnet.so" | "mock_swap.so") {
  const bytes = readFileSync(new URL(name, bin));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest[name], `${name} matches programs/bin/MANIFEST.json`);
  return bytes;
}

export type SendResult = { ok: boolean; logs: string[]; error: string };

/** In-memory LiteSVM only: local keypairs, synthetic mints and balances. No RPC, no keys on disk. */
export function navVaultVm(build: "devnet" | "mainnet" = "devnet", options: { mockAtJupiter?: boolean } = {}) {
  // Sends are signed with real local keypairs; sigverify is off only so unsigned prepare
  // messages can be simulated (the program's signer checks come from the message header).
  const svm = new LiteSVM().withSigverify(false);
  const programId = build === "devnet" ? NAV_VAULT_DEVNET_PROGRAM_ID : NAV_VAULT_PROGRAM_ID;
  setDefaultProgramId(programId);
  svm.addProgram(address(programId.toBase58()), programBinary(build === "devnet" ? "nav_vault_devnet.so" : "nav_vault.so"));
  svm.addProgram(address(MOCK_SWAP_PROGRAM_ID.toBase58()), programBinary("mock_swap.so"));
  if (options.mockAtJupiter) svm.addProgram(address(JUPITER_V6_PROGRAM_ID.toBase58()), programBinary("mock_swap.so"));
  const clock = svm.getClock();
  svm.setClock(new Clock(clock.slot + 10n, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, 1_800_000_000n));

  function fund(key: PublicKey, sol = 10n) { svm.airdrop(address(key.toBase58()), lamports(sol * 1_000_000_000n)); }
  function send(instructions: TransactionInstruction[], payer: Keypair, signers: Keypair[] = [], tables: AddressLookupTableAccount[] = []): SendResult {
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: svm.latestBlockhash(), instructions }).compileToV0Message(tables));
    tx.sign([payer, ...signers.filter(s => !s.publicKey.equals(payer.publicKey))]);
    return sendRaw(tx.serialize());
  }
  function sendRaw(bytes: Uint8Array): SendResult {
    const result = svm.sendTransaction(getTransactionDecoder().decode(bytes));
    svm.expireBlockhash();
    if (result instanceof FailedTransactionMetadata) return { ok: false, logs: result.meta().logs(), error: result.err().toString() };
    return { ok: true, logs: result.logs(), error: "" };
  }
  function must(result: SendResult, label = "transaction") {
    assert.ok(result.ok, `${label} failed: ${result.error}\n${result.logs.join("\n")}`);
    return result;
  }
  function info(key: PublicKey) {
    const a = svm.getAccount(address(key.toBase58()));
    return a.exists ? { data: Buffer.from(a.data), owner: new PublicKey(a.programAddress), lamports: Number(a.lamports), executable: a.executable, rentEpoch: 0 } : null;
  }
  function balance(tokenAccount: PublicKey) { return tokenAmount(info(tokenAccount)?.data); }
  function supply(mint: PublicKey) { return Buffer.from(info(mint)!.data).readBigUInt64LE(36); }
  function createMint(payer: Keypair, decimals: number, program = TOKEN_PROGRAM_ID) {
    const mint = Keypair.generate();
    const rent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    must(send([
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: Number(rent), space: MINT_SIZE, programId: program }),
      createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null, program),
    ], payer, [mint]), "create mint");
    return mint.publicKey;
  }
  function mintTo(payer: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint, program = TOKEN_PROGRAM_ID) {
    const account = ata(owner, mint, program);
    must(send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, account, owner, mint, program),
      ...(amount > 0n ? [createMintToInstruction(mint, account, payer.publicKey, amount, [], program)] : []),
    ], payer), "mint to");
    return account;
  }
  function advance(seconds: number, slots = 1n) {
    const c = svm.getClock();
    svm.setClock(new Clock(c.slot + slots, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)));
  }
  function vault(indexId: string): NavVaultState { return decodeVault(vaultPda(indexId), info(vaultPda(indexId))!.data); }
  /** Install an ACTIVE address lookup table directly (no warm-up slots needed in the VM). */
  function installLut(addresses: PublicKey[]): AddressLookupTableAccount {
    const key = Keypair.generate().publicKey;
    const header = Buffer.alloc(56);
    header.writeUInt32LE(1, 0);
    header.writeBigUInt64LE(0xffffffffffffffffn, 4);
    header.writeBigUInt64LE(0n, 12);
    const data = Buffer.concat([header, ...addresses.map(a => a.toBuffer())]);
    svm.setAccount({ address: address(key.toBase58()), lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))), data, programAddress: address("AddressLookupTab1e1111111111111111111111111"), executable: false, space: BigInt(data.length) });
    return new AddressLookupTableAccount({ key, state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses } });
  }
  const connection: NavConnection = {
    getAccountInfo: (async (key: PublicKey) => info(key)) as NavConnection["getAccountInfo"],
    getMultipleAccountsInfo: (async (keys: PublicKey[]) => keys.map(info)) as NavConnection["getMultipleAccountsInfo"],
    getLatestBlockhash: (async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(svm.getClock().slot) + 150 })) as NavConnection["getLatestBlockhash"],
    getAddressLookupTable: (async (key: PublicKey) => {
      const a = info(key);
      return { context: { slot: Number(svm.getClock().slot) }, value: a ? new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(a.data) }) : null };
    }) as unknown as NavConnection["getAddressLookupTable"],
    getProgramAccounts: (async (programId: PublicKey, config: { filters?: { memcmp: { offset: number; bytes: string } }[] }) => {
      return svm.getProgramAccounts(address(programId.toBase58())).flatMap(a => {
        const data = Buffer.from(a.data);
        const ok = (config.filters ?? []).every(f => { const want = Buffer.from(bs58.decode(f.memcmp.bytes)); return data.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want); });
        return ok ? [{ pubkey: new PublicKey(a.address), account: { data, owner: new PublicKey(a.programAddress), lamports: Number(a.lamports), executable: a.executable, rentEpoch: 0 } }] : [];
      });
    }) as unknown as NavConnection["getProgramAccounts"],
    simulateTransaction: (async (tx: VersionedTransaction) => {
      const copy = VersionedTransaction.deserialize(tx.serialize());
      copy.signatures = copy.signatures.map(() => new Uint8Array(64).fill(1));
      const result = svm.simulateTransaction(getTransactionDecoder().decode(copy.serialize()));
      const failed = result instanceof FailedTransactionMetadata;
      return { context: { slot: Number(svm.getClock().slot) }, value: { err: failed ? result.err().toString() : null, logs: failed ? result.meta().logs() : result.meta().logs() } };
    }) as unknown as NavConnection["simulateTransaction"],
  };
  return { svm, fund, send, sendRaw, must, info, balance, supply, createMint, mintTo, advance, vault, installLut, connection };
}
export type NavVm = ReturnType<typeof navVaultVm>;

export const USDC_DECIMALS = 6;
/** $200 per whole A (6 dp, classic SPL) and $400 per whole B (8 dp, Token-2022, like xStocks). */
export const PRICE_A = 200_000_000n;
export const PRICE_B = 400_000_000n;

/** Test index: default two legs (60/40: A classic 6dp @ $200, B Token-2022 8dp @ $400), or `legCount`
 * legs for cap tests. 25 bps entry fee, 5% buffer, 300 s max mark age, 100 bps keeper slippage,
 * 15% mark band, 600 s request timeout. A vault LUT is installed so every path fits one packet. */
export function seedIndex(vm: NavVm, indexId = "idx-test-nav", options: { legCount?: number; requestTimeoutSecs?: number; keeper?: Keypair } = {}) {
  const admin = Keypair.generate(), keeper = options.keeper ?? Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate();
  for (const k of [admin, keeper, alice, bob]) vm.fund(k.publicKey, 50n);
  const usdc = vm.createMint(admin, USDC_DECIMALS);
  const legCount = options.legCount ?? 2;
  const legs = Array.from({ length: legCount }, (_, i) => {
    const token2022 = i % 2 === 1;
    const mint = vm.createMint(admin, token2022 ? 8 : 6, token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
    const weightBps = legCount === 2 ? [6000, 4000][i]! : Math.floor(10_000 / legCount) + (i === 0 ? 10_000 - Math.floor(10_000 / legCount) * legCount : 0);
    return { mint, tokenProgram: token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, weightBps, price: token2022 ? PRICE_B : PRICE_A };
  });
  const [legA, legB] = [legs[0]!.mint, legs[1]?.mint ?? legs[0]!.mint];
  const accounts = vaultTokenAccounts(indexId, usdc, legs);
  const feeAccount = vm.mintTo(admin, usdc, admin.publicKey, 0n);
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.usdc, accounts.authority, usdc),
    ...legs.map((leg, i) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.legs[i]!, accounts.authority, leg.mint, leg.tokenProgram)),
  ];
  for (let i = 0; i < ataIxs.length; i += 6) vm.must(vm.send(ataIxs.slice(i, i + 6), admin), "vault atas");
  const init = initVaultIx({ admin: admin.publicKey, indexId, keeper: keeper.publicKey, usdcMint: usdc, feeAccount, maxPriceAgeSecs: 300, maxSlippageBps: 100, entryFeeBps: 25, bufferBps: 500, requestTimeoutSecs: options.requestTimeoutSecs ?? 600, legs });
  const initLut = vm.installLut([...new Set(init.keys.map(k => k.pubkey.toBase58()))].map(k => new PublicKey(k)).filter(k => !k.equals(admin.publicKey)));
  vm.must(vm.send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), init], admin, [], [initLut]), "init vault");
  const state = vm.vault(indexId);
  const lut = vm.installLut(vaultLookupAddresses(state));
  vm.must(vm.send([setLookupTableIx(state, admin.publicKey, lut.key)], admin), "set lut");
  // Mock venue pools (base = leg, quote = USDC) with deep synthetic reserves.
  for (const leg of legs) {
    vm.must(vm.send([mockInitPoolIx(admin.publicKey, leg.mint, usdc, leg.price)], admin), "mock pool");
    const pool = mockPoolPda(leg.mint, usdc);
    vm.mintTo(admin, leg.mint, pool, 1_000_000_000_000_000n, leg.tokenProgram);
    vm.mintTo(admin, usdc, pool, 1_000_000_000_000n);
  }
  vm.mintTo(admin, usdc, alice.publicKey, 10_000_000_000n);
  vm.mintTo(admin, usdc, bob.publicKey, 10_000_000_000n);
  vm.mintTo(admin, usdc, keeper.publicKey, 10_000_000_000n);
  return { indexId, admin, keeper, alice, bob, usdc, legA, legB, legs, accounts, feeAccount, lut, prices: legs.map(l => l.price) };
}
