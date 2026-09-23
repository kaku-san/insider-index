import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import {
  AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction, createMintToInstruction,
} from "@solana/spl-token";
import {
  JUPITER_V6_PROGRAM_ID, MOCK_SWAP_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, ata, decodeVault, initVaultIx, mockInitPoolIx,
  mockPoolPda, tokenAmount, vaultPda, vaultTokenAccounts, type NavVaultState,
} from "../../src/lib/nav-vault/program.ts";
import type { NavConnection } from "../../src/lib/nav-vault/prepare.ts";

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
  svm.addProgram(address(NAV_VAULT_PROGRAM_ID.toBase58()), programBinary(build === "devnet" ? "nav_vault_devnet.so" : "nav_vault.so"));
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
  const connection: NavConnection = {
    getAccountInfo: (async (key: PublicKey) => info(key)) as NavConnection["getAccountInfo"],
    getMultipleAccountsInfo: (async (keys: PublicKey[]) => keys.map(info)) as NavConnection["getMultipleAccountsInfo"],
    getLatestBlockhash: (async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(svm.getClock().slot) + 150 })) as NavConnection["getLatestBlockhash"],
    getAddressLookupTable: (async () => ({ context: { slot: Number(svm.getClock().slot) }, value: null })) as unknown as NavConnection["getAddressLookupTable"],
    simulateTransaction: (async (tx: VersionedTransaction) => {
      const copy = VersionedTransaction.deserialize(tx.serialize());
      copy.signatures = copy.signatures.map(() => new Uint8Array(64).fill(1));
      const result = svm.simulateTransaction(getTransactionDecoder().decode(copy.serialize()));
      const failed = result instanceof FailedTransactionMetadata;
      return { context: { slot: Number(svm.getClock().slot) }, value: { err: failed ? result.err().toString() : null, logs: failed ? result.meta().logs() : result.meta().logs() } };
    }) as unknown as NavConnection["simulateTransaction"],
  };
  return { svm, fund, send, sendRaw, must, info, balance, supply, createMint, mintTo, advance, vault, connection };
}
export type NavVm = ReturnType<typeof navVaultVm>;

export const USDC_DECIMALS = 6;
/** $200 per whole A (6 dp, classic SPL) and $400 per whole B (8 dp, Token-2022, like xStocks). */
export const PRICE_A = 200_000_000n;
export const PRICE_B = 400_000_000n;

/** Two-leg test index (60/40), 25 bps entry fee, 5% buffer, 300 s max mark age, 100 bps keeper slippage. */
export function seedIndex(vm: NavVm, indexId = "idx-test-nav") {
  const admin = Keypair.generate(), keeper = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate();
  for (const k of [admin, keeper, alice, bob]) vm.fund(k.publicKey);
  const usdc = vm.createMint(admin, USDC_DECIMALS);
  const legA = vm.createMint(admin, 6);
  const legB = vm.createMint(admin, 8, TOKEN_2022_PROGRAM_ID);
  const legs = [
    { mint: legA, tokenProgram: TOKEN_PROGRAM_ID, weightBps: 6000 },
    { mint: legB, tokenProgram: TOKEN_2022_PROGRAM_ID, weightBps: 4000 },
  ];
  const accounts = vaultTokenAccounts(indexId, usdc, legs);
  const feeAccount = vm.mintTo(admin, usdc, admin.publicKey, 0n);
  vm.must(vm.send([
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.usdc, accounts.authority, usdc),
    ...legs.map((leg, i) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.legs[i]!, accounts.authority, leg.mint, leg.tokenProgram)),
    initVaultIx({ admin: admin.publicKey, indexId, keeper: keeper.publicKey, usdcMint: usdc, feeAccount, maxPriceAgeSecs: 300, maxSlippageBps: 100, entryFeeBps: 25, bufferBps: 500, legs }),
  ], admin), "init vault");
  // Mock venue pools (base = leg, quote = USDC) with deep synthetic reserves.
  for (const [mint, program, price] of [[legA, TOKEN_PROGRAM_ID, PRICE_A], [legB, TOKEN_2022_PROGRAM_ID, PRICE_B]] as const) {
    vm.must(vm.send([mockInitPoolIx(admin.publicKey, mint, usdc, price)], admin), "mock pool");
    const pool = mockPoolPda(mint, usdc);
    vm.mintTo(admin, mint, pool, 1_000_000_000_000_000n, program);
    vm.mintTo(admin, usdc, pool, 1_000_000_000_000n);
  }
  vm.mintTo(admin, usdc, alice.publicKey, 10_000_000_000n);
  vm.mintTo(admin, usdc, bob.publicKey, 10_000_000_000n);
  vm.mintTo(admin, usdc, keeper.publicKey, 10_000_000_000n);
  return { indexId, admin, keeper, alice, bob, usdc, legA, legB, legs, accounts, feeAccount };
}
