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
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction,
} from "@solana/spl-token";
import {
  MOCK_SWAP_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, ata, decodeRequest, decodeVault, depositIx, initVaultIx, mockInitPoolIx, mockPoolPda, setLookupTableIx, setPausedIx, shareAta, tokenAmount, updatePricesIx,
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
  await send("init_vault (mainnet params: 60/40, 25 bps entry fee, 5% buffer, 60 s marks, 15% band, no deposit cap, 600 s request timeout)", [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    initVaultIx({ admin: payer.publicKey, indexId, keeper: keeper.publicKey, usdcMint: usdc, feeAccount, maxPriceAgeSecs: 60, maxSlippageBps: 100, entryFeeBps: 25, bufferBps: 500, maxDepositUsdc: 0n, requestTimeoutSecs: 600, legs }),
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
  const tables = [(await connection.getAddressLookupTable(lut)).value!];
  const simulate = async (label: string, payerKey: PublicKey, ixs: TransactionInstruction[], expect: RegExp) => {
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs] }).compileToV0Message(tables));
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    const hit = (sim.value.logs ?? []).find(line => expect.test(line));
    if (!hit) throw new Error(`${label}: expected ${expect}, got ${JSON.stringify(sim.value.err)}`);
    record.steps.push({ step: `${label} — refused on chain (simulated, not sent)`, signature: "", explorer: "", readback: { error: expect.source, slot: sim.context.slot } });
    save();
  };
  state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
  // Price band: a 20% jump is refused for the keeper.
  await simulate("keeper posts a +20% mark", keeper.publicKey, [updatePricesIx(state, keeper.publicKey, state.legs.map(l => l.price * 120n / 100n))], /PriceMoveTooLarge/);

  // ONE-signature deposit.
  const dep = await prepareNavDeposit({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), amountRaw: "50000000" });
  if (dep.transactions.length !== 1) throw new Error("deposit prepare must return one transaction");
  await sendVersioned("user deposit 50 tUSDC (ONE signature)", VersionedTransaction.deserialize(Buffer.from(dep.transactions[0]!.messageBase64, "base64")), user,
    `expected shares ${dep.estimate.sharesRaw}, fee ${dep.navVault.feeRaw}`,
    async () => ({ userShares: (await balance(shareAta(user.publicKey, state.shareMint))).toString(), vaultUsdc: (await balance(accounts.usdc)).toString(), fee: (await balance(feeAccount)).toString() }));

  // Keeper buys toward 60/40 down to the 5% buffer, one swap per leg, from vault USDC only.
  const keeperUsdcBefore = await balance(ata(keeper.publicKey, usdc));
  const buys = await keeperTick({ connection, indexId, keeper: keeper.publicKey, ...venue, execute, afterPrices: async () => waitSlot(await connection.getSlot("confirmed")) });
  let snap = (await readNavVault(connection, indexId))!;
  record.steps.push({ step: "keeper readback", signature: "", explorer: "", readback: { plan: buys.plan, usdc: snap.usdcBalance, legs: snap.legBalances, nav: snap.nav, bufferBpsNow: Number(snap.usdcBalance * 10_000n / snap.nav), keeperUsdcUnchanged: (await balance(ata(keeper.publicKey, usdc))) === keeperUsdcBefore } });
  save();

  // ONE-signature instant USDC exit (small, the buffer covers it).
  await refreshMarks();
  const small = await prepareNavWithdraw({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), shareAmountRaw: "2000000" });
  if (small.transactions.length !== 1 || small.navVault.path !== "usdc") throw new Error(`expected one-tx USDC exit, got ${small.navVault.path}`);
  let usdcBefore = await balance(ata(user.publicKey, usdc));
  await sendVersioned("user cash out 2 shares → instant USDC from the buffer (ONE signature)", VersionedTransaction.deserialize(Buffer.from(small.transactions[0]!.messageBase64, "base64")), user, small.estimate.outputSummary,
    async () => ({ usdcReceived: ((await balance(ata(user.publicKey, usdc))) - usdcBefore).toString(), expected: small.estimate.returnedUsdcRaw }));

  // ONE-signature USDC cash-out via keeper: buffer short → request carves the slice; keeper sells and pays USDC.
  await refreshMarks();
  const medium = await prepareNavWithdraw({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), shareAmountRaw: "20000000" });
  if (medium.transactions.length !== 1 || medium.navVault.path !== "request") throw new Error(`expected one-tx keeper request, got ${medium.navVault.path}`);
  usdcBefore = await balance(ata(user.publicKey, usdc));
  await sendVersioned("user cash out 20 shares → buffer short → keeper request (ONE signature)", VersionedTransaction.deserialize(Buffer.from(medium.transactions[0]!.messageBase64, "base64")), user, medium.estimate.outputSummary,
    async () => { const r = decodeRequest(new PublicKey(medium.navVault.request!), (await connection.getAccountInfo(new PublicKey(medium.navVault.request!)))!.data); return { request: medium.navVault.request, carvedLegs: r.legAmounts, carvedUsdc: r.usdcOwed, minUsdc: r.minUsdc }; });
  const cycles: unknown[] = [];
  for (let n = 0; n < 3; n++) {
    const cycle = await keeperTick({ connection, indexId, keeper: keeper.publicKey, ...venue, execute, afterPrices: async () => waitSlot(await connection.getSlot("confirmed")) });
    cycles.push({ requests: cycle.requests, plan: cycle.plan });
    if ((await connection.getAccountInfo(new PublicKey(medium.navVault.request!))) === null) break;
  }
  record.steps.push({ step: "keeper cycle readback (request converted + settled)", signature: "", explorer: "", readback: {
    cycles, usdcReceived: ((await balance(ata(user.publicKey, usdc))) - usdcBefore).toString(),
    requestClosed: (await connection.getAccountInfo(new PublicKey(medium.navVault.request!))) === null, estimate: medium.estimate.returnedUsdcRaw,
  } });
  save();

  // Admin pause: deposits refused (simulated) while the in-kind exit stays open; then unpause.
  await send("admin pause", [setPausedIx(state, payer.publicKey, true)], payer);
  state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
  await simulate("deposit while paused", user.publicKey, [depositIx(state, user.publicKey, 1_000_000n, 0n)], /Error Code: Paused/);

  // ONE-signature in-kind exit of everything else (request + claim in the same tx; works while paused).
  const rest = (await balance(shareAta(user.publicKey, state.shareMint))).toString();
  const big = await prepareNavWithdraw({ connection, network: "devnet", indexId, owner: user.publicKey.toBase58(), shareAmountRaw: rest });
  if (big.transactions.length !== 1 || big.navVault.path !== "in-kind") throw new Error(`expected one-tx in-kind exit, got ${big.navVault.path}`);
  const before = { usdc: await balance(ata(user.publicKey, usdc)), a: await balance(ata(user.publicKey, legs[0]!.mint)), b: await balance(ata(user.publicKey, legs[1]!.mint, TOKEN_2022_PROGRAM_ID)) };
  await sendVersioned("user cash out all remaining shares while paused → pro-rata in kind (ONE signature: request + claim)", VersionedTransaction.deserialize(Buffer.from(big.transactions[0]!.messageBase64, "base64")), user, big.estimate.outputSummary,
    async () => ({
      expectedInKind: big.navVault.inKind, expectedUsdc: big.estimate.returnedUsdcRaw,
      usdcReceived: ((await balance(ata(user.publicKey, usdc))) - before.usdc).toString(),
      stockA: ((await balance(ata(user.publicKey, legs[0]!.mint))) - before.a).toString(),
      stockB: ((await balance(ata(user.publicKey, legs[1]!.mint, TOKEN_2022_PROGRAM_ID))) - before.b).toString(),
      userSharesAfter: (await balance(shareAta(user.publicKey, state.shareMint))).toString(),
      requestClosed: (await connection.getAccountInfo(new PublicKey(big.navVault.request!))) === null,
    }));
  await send("admin unpause", [setPausedIx(state, payer.publicKey, false)], payer);
  snap = (await readNavVault(connection, indexId))!;
  record.steps.push({ step: "final readback", signature: "", explorer: "", readback: { supply: snap.supply, reservedUsdc: snap.state.reservedUsdc, reservedLegs: snap.state.legs.map(l => l.reserved), paused: snap.state.paused } });
  save();
  console.log(`wrote ${outPath}`);
}

main().catch(error => { console.error(error); save(); process.exit(1); });
