/**
 * Devnet end-to-end proof for the NAV vault (programs/nav-vault, `devnet` feature build).
 * Deploy first with the Solana CLI (see docs/nav-vault.md). DEVNET ONLY: refuses any other genesis.
 *
 *   node --experimental-strip-types scripts/nav-vault-devnet.mts --payer PATH [--out evidence/vaults/nav-vault-devnet.json]
 *
 * Creates synthetic devnet test mints (test USDC + two stock stand-ins, one Token-2022), a mock
 * fixed-price venue (Jupiter has no devnet deployment), a keeper and a user keypair under
 * .toolchain/keys (gitignored), then: init_vault → LUT → keeper marks → ONE-signature deposit →
 * keeper buys (one swap per tx) → ONE-signature USDC exit → ONE-signature exit that falls back to
 * the pro-rata in-kind basket. Every signature is recorded with post-state readback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction,
} from "@solana/spl-token";
import {
  MOCK_SWAP_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, ata, decodeVault, depositIx, initVaultIx, mockInitPoolIx, mockPoolPda, setLookupTableIx, tokenAmount,
  vaultLookupAddresses, vaultPda, vaultTokenAccounts,
} from "../src/lib/nav-vault/program.ts";
import { prepareNavDeposit, prepareNavWithdraw, readNavVault } from "../src/lib/nav-vault/prepare.ts";
import { keeperTick, mockVenue } from "../src/lib/nav-vault/keeper.ts";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const localnet = process.argv.includes("--localnet"); // rehearsal against solana-test-validator only
const RPC = localnet ? "http://127.0.0.1:8899" : process.env.NAV_VAULT_DEVNET_RPC ?? "https://api.devnet.solana.com";
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const payerPath = arg("--payer");
if (!payerPath) throw new Error("--payer PATH is required (devnet keypair file).");
const outPath = arg("--out") ?? "evidence/vaults/nav-vault-devnet.json";
const indexId = arg("--index") ?? `idx-nav-devnet-${new Date().toISOString().slice(0, 10)}`;
const keysDir = localnet ? ".toolchain/keys/localnet" : ".toolchain/keys";
mkdirSync(keysDir, { recursive: true });

const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
function localKey(name: string) {
  const path = `${keysDir}/${name}.json`;
  if (!existsSync(path)) writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return load(path);
}
const connection = new Connection(RPC, { commitment: "confirmed" });
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const record: { network: "devnet"; rpc: string; indexId: string; programs: Record<string, string>; accounts: Record<string, string>; steps: { step: string; signature: string; explorer: string; note?: string; readback?: unknown }[] } = {
  network: localnet ? "localnet-rehearsal" as "devnet" : "devnet", rpc: RPC, indexId, programs: { navVault: NAV_VAULT_PROGRAM_ID.toBase58(), mockSwap: MOCK_SWAP_PROGRAM_ID.toBase58() }, accounts: {}, steps: [],
};
const save = () => writeFileSync(outPath, `${JSON.stringify(record, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)}\n`);

async function send(step: string, instructions: TransactionInstruction[], payer: Keypair, signers: Keypair[] = [], note?: string) {
  const tx = new Transaction().add(...instructions);
  const signature = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], { commitment: "confirmed" });
  record.steps.push({ step, signature, explorer: explorer(signature), ...(note ? { note } : {}) });
  save();
  console.log(step, signature);
  return signature;
}
async function sendVersioned(step: string, tx: VersionedTransaction, signer: Keypair, note?: string, readback?: () => Promise<unknown>) {
  tx.sign([signer]);
  const signature = await connection.sendTransaction(tx, { skipPreflight: false });
  const latest = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`${step} failed: ${JSON.stringify(result.value.err)}`);
  record.steps.push({ step, signature, explorer: explorer(signature), ...(note ? { note } : {}), ...(readback ? { readback: await readback() } : {}) });
  save();
  console.log(step, signature);
  return signature;
}
async function waitSlot(after: number) { while ((await connection.getSlot("confirmed")) <= after) await new Promise(r => setTimeout(r, 400)); }
async function balance(account: PublicKey) { return tokenAmount((await connection.getAccountInfo(account, "confirmed"))?.data); }

async function main() {
  if (!localnet && (await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Refusing: RPC is not devnet.");
  for (const id of [NAV_VAULT_PROGRAM_ID, MOCK_SWAP_PROGRAM_ID]) {
    const info = await connection.getAccountInfo(id);
    if (!info?.executable) throw new Error(`Program ${id.toBase58()} is not deployed on devnet.`);
  }
  const payer = load(payerPath!);
  const keeper = localKey("devnet-keeper"), user = localKey("devnet-user");
  Object.assign(record.accounts, { payer: payer.publicKey.toBase58(), keeper: keeper.publicKey.toBase58(), user: user.publicKey.toBase58() });
  await send("fund keeper + user (SOL for fees/rent)", [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: keeper.publicKey, lamports: 20_000_000 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: user.publicKey, lamports: 60_000_000 }),
  ], payer);

  // Synthetic devnet test mints (NOT real USDC/xStocks). Leg B is Token-2022 with 8 decimals like xStocks.
  const mints = { usdc: Keypair.generate(), legA: Keypair.generate(), legB: Keypair.generate() };
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const spec = [[mints.usdc, 6, TOKEN_PROGRAM_ID], [mints.legA, 6, TOKEN_PROGRAM_ID], [mints.legB, 8, TOKEN_2022_PROGRAM_ID]] as const;
  await send("create test mints (tUSDC, tSTOCKA classic 6dp, tSTOCKB Token-2022 8dp)", spec.flatMap(([kp, decimals, program]) => [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, lamports: rent, space: MINT_SIZE, programId: program }),
    createInitializeMint2Instruction(kp.publicKey, decimals, payer.publicKey, null, program),
  ]), payer, [mints.usdc, mints.legA, mints.legB]);
  const usdc = mints.usdc.publicKey;
  const legs = [
    { mint: mints.legA.publicKey, tokenProgram: TOKEN_PROGRAM_ID, weightBps: 6000 },
    { mint: mints.legB.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID, weightBps: 4000 },
  ];
  Object.assign(record.accounts, { testUsdcMint: usdc.toBase58(), testStockA: legs[0]!.mint.toBase58(), testStockB: legs[1]!.mint.toBase58() });

  const accounts = vaultTokenAccounts(indexId, usdc, legs);
  const feeAccount = ata(payer.publicKey, usdc);
  await send("vault token accounts (authority PDA ATAs) + fee account", [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, feeAccount, payer.publicKey, usdc),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, accounts.usdc, accounts.authority, usdc),
    ...legs.map((leg, i) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, accounts.legs[i]!, accounts.authority, leg.mint, leg.tokenProgram)),
  ], payer);
  await send("init_vault (60/40, 25 bps entry fee, 5% buffer, 60 s max mark age, $50 per-deposit cap — mainnet pilot params)", [
    initVaultIx({ admin: payer.publicKey, indexId, keeper: keeper.publicKey, usdcMint: usdc, feeAccount, maxPriceAgeSecs: 60, maxSlippageBps: 100, entryFeeBps: 25, bufferBps: 500, maxDepositUsdc: 50_000_000n, legs }),
  ], payer);
  const vault = vaultPda(indexId);
  let state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
  Object.assign(record.accounts, { vault: vault.toBase58(), authority: accounts.authority.toBase58(), shareMint: state.shareMint.toBase58(), vaultUsdc: accounts.usdc.toBase58(), feeAccount: feeAccount.toBase58() });

  const slot = await connection.getSlot("finalized");
  const [createLut, lut] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  await send("vault lookup table", [createLut, AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: vaultLookupAddresses(state) }), setLookupTableIx(state, payer.publicKey, lut)], payer);
  record.accounts.lookupTable = lut.toBase58();

  // Mock venue pools (devnet stand-in for Jupiter) with synthetic reserves. $200 and $400 marks.
  for (const [leg, price] of [[legs[0]!, 200_000_000n], [legs[1]!, 400_000_000n]] as const) {
    const pool = mockPoolPda(leg.mint, usdc);
    await send(`mock pool ${leg.mint.toBase58().slice(0, 6)}`, [
      mockInitPoolIx(payer.publicKey, leg.mint, usdc, price),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(pool, leg.mint, leg.tokenProgram), pool, leg.mint, leg.tokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(pool, usdc), pool, usdc),
      createMintToInstruction(leg.mint, ata(pool, leg.mint, leg.tokenProgram), payer.publicKey, 10n ** 15n, [], leg.tokenProgram),
      createMintToInstruction(usdc, ata(pool, usdc), payer.publicKey, 10n ** 12n),
    ], payer);
  }
  await send("user test USDC (100)", [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(user.publicKey, usdc), user.publicKey, usdc),
    createMintToInstruction(usdc, ata(user.publicKey, usdc), payer.publicKey, 100_000_000n),
  ], payer);
  await waitSlot(await connection.getSlot("confirmed") + 2); // LUT activation

  const venue = mockVenue(connection, usdc);
  const execute = async (tx: VersionedTransaction, step: string) => sendVersioned(`keeper ${step}`, tx, keeper);
  // Keeper marks first (no trades yet: vault is empty).
  const marks = await keeperTick({ connection, indexId, keeper: keeper.publicKey, ...venue, execute, afterPrices: async () => waitSlot(await connection.getSlot("confirmed")) });
  console.log("marks", marks.marks);

  const refreshMarks = async () => { await keeperTick({ connection, indexId, keeper: keeper.publicKey, ...venue, execute, maxSwaps: 0, afterPrices: async () => waitSlot(await connection.getSlot("confirmed")) }); };
  // The $50 pilot cap is enforced on chain: simulate a 50.000001 deposit (not sent).
  {
    state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
    const latest = await connection.getLatestBlockhash("confirmed");
    const over = new VersionedTransaction(new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: latest.blockhash, instructions: [
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, ata(user.publicKey, state.shareMint), user.publicKey, state.shareMint),
      depositIx(state, user.publicKey, 50_000_001n, 0n),
    ] }).compileToV0Message());
    const sim = await connection.simulateTransaction(over, { sigVerify: false });
    const refused = (sim.value.logs ?? []).some(line => /DepositAboveCap/.test(line));
    if (!refused) throw new Error("expected the on-chain cap to refuse 50.000001 USDC");
    record.steps.push({ step: "simulate deposit 50.000001 tUSDC (above $50 cap) — refused on chain, not sent", signature: "", explorer: "", readback: { error: "DepositAboveCap", slot: sim.context.slot } });
    save();
  }
  // ONE-signature deposit at the cap.
  const dep = await prepareNavDeposit({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), amountRaw: "50000000" });
  if (dep.transactions.length !== 1) throw new Error("deposit prepare must return one transaction");
  await sendVersioned("user deposit 50 tUSDC (ONE signature, at the cap)", VersionedTransaction.deserialize(Buffer.from(dep.transactions[0].messageBase64, "base64")), user,
    `expected shares ${dep.estimate.sharesRaw}, fee ${dep.navVault.feeRaw}`,
    async () => ({ userShares: (await balance(ata(user.publicKey, state.shareMint))).toString(), vaultUsdc: (await balance(accounts.usdc)).toString(), fee: (await balance(feeAccount)).toString() }));

  // Keeper buys toward 60/40 down to the 5% buffer, one swap per tx, from vault USDC only.
  const keeperUsdcBefore = await balance(ata(keeper.publicKey, usdc));
  const buys = await keeperTick({ connection, indexId, keeper: keeper.publicKey, ...venue, execute, afterPrices: async () => waitSlot(await connection.getSlot("confirmed")) });
  const snap = (await readNavVault(connection, indexId))!;
  record.steps.push({ step: "keeper readback", signature: "", explorer: "", readback: { plan: buys.plan, usdc: snap.usdcBalance, legs: snap.legBalances, nav: snap.nav, bufferBpsNow: Number(snap.usdcBalance * 10_000n / snap.nav), keeperUsdcUnchanged: (await balance(ata(keeper.publicKey, usdc))) === keeperUsdcBefore } });
  save();

  // ONE-signature USDC exit (small, buffer covers it). Marks are refreshed first (60 s max age).
  await refreshMarks();
  const small = await prepareNavWithdraw({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), shareAmountRaw: "2000000" });
  if (small.transactions.length !== 1 || small.navVault.path !== "usdc") throw new Error(`expected one-tx USDC exit, got ${small.navVault.path}`);
  const usdcBefore = await balance(ata(user.publicKey, usdc));
  await sendVersioned("user cash out 2 shares → USDC buffer (ONE signature)", VersionedTransaction.deserialize(Buffer.from(small.transactions[0].messageBase64, "base64")), user, small.estimate.outputSummary,
    async () => ({ usdcReceived: ((await balance(ata(user.publicKey, usdc))) - usdcBefore).toString(), expected: small.estimate.returnedUsdcRaw }));

  // ONE-signature exit of everything else: buffer is short → pro-rata in-kind basket.
  await refreshMarks();
  state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
  const rest = (await balance(ata(user.publicKey, state.shareMint))).toString();
  const big = await prepareNavWithdraw({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), shareAmountRaw: rest });
  if (big.transactions.length !== 1 || big.navVault.path !== "in-kind") throw new Error(`expected one-tx in-kind exit, got ${big.navVault.path}`);
  const before = { usdc: await balance(ata(user.publicKey, usdc)) };
  await sendVersioned("user cash out all remaining shares → buffer short → pro-rata in-kind (ONE signature)", VersionedTransaction.deserialize(Buffer.from(big.transactions[0].messageBase64, "base64")), user, big.estimate.outputSummary,
    async () => ({
      expectedInKind: big.navVault.inKind, expectedUsdc: big.estimate.returnedUsdcRaw,
      usdcReceived: ((await balance(ata(user.publicKey, usdc))) - before.usdc).toString(),
      stockA: (await balance(ata(user.publicKey, legs[0]!.mint))).toString(),
      stockB: (await balance(ata(user.publicKey, legs[1]!.mint, TOKEN_2022_PROGRAM_ID))).toString(),
      userSharesAfter: (await balance(ata(user.publicKey, state.shareMint))).toString(),
    }));
  console.log(`wrote ${outPath}`);
}

main().catch(error => { console.error(error); save(); process.exit(1); });
