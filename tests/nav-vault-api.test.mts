import test from "node:test";
import assert from "node:assert/strict";
import { updatePricesIx } from "../src/lib/nav-vault/program.ts";
import { navVaultConfig, navVaultServes } from "../src/lib/nav-vault/config.ts";
import { handleNavDepositPrepare, handleNavPosition, handleNavReadiness, handleNavWithdrawPrepare, type NavDependencies } from "../src/lib/nav-vault/server.ts";
import { navVaultVm, seedIndex, PRICE_A, PRICE_B } from "./support/nav-vault-vm.mts";

function setup() {
  const vm = navVaultVm();
  const s = seedIndex(vm, "idx-theme-mag7-caucus");
  vm.must(vm.send([updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A, PRICE_B])], s.keeper));
  vm.advance(1);
  const deps: NavDependencies = {
    config: () => navVaultConfig({ STOCKLANA_NAV_VAULT_INDEXES: s.indexId }),
    connection: () => vm.connection,
    now: () => Number(vm.svm.getClock().unixTimestamp),
  };
  return { vm, s, deps };
}
const post = (body: unknown) => new Request("http://local/api", { method: "POST", body: JSON.stringify(body) });

test("NAV vault flag is off by default; mainnet only when chosen explicitly", () => {
  assert.equal(navVaultConfig({}).enabled, false);
  assert.equal(navVaultConfig({}).network, "devnet");
  assert.equal(navVaultServes("idx-theme-mag7-caucus", navVaultConfig({})), false);
  const mainnet = navVaultConfig({ STOCKLANA_NAV_VAULT_INDEXES: "x", STOCKLANA_NAV_VAULT_NETWORK: "mainnet-beta", STOCKLANA_NAV_VAULT_RPC_URL: "https://rpc.example" });
  assert.equal(mainnet.network, "mainnet-beta");
  assert.equal(mainnet.rpcUrl, "https://rpc.example");
  assert.throws(() => navVaultConfig({ STOCKLANA_NAV_VAULT_INDEXES: "x", STOCKLANA_NAV_VAULT_NETWORK: "testnet" }), /devnet or mainnet-beta/);
  // Branch preview only: this branch's Vercel preview serves Mag7 from the mainnet vault; production never.
  const preview = navVaultConfig({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "fm/stocklana-nav-vault-f1" });
  assert.deepEqual([preview.enabled, preview.network, preview.indexes], [true, "mainnet-beta", ["idx-theme-mag7-caucus"]]);
  assert.equal(preview.programId.toBase58(), "HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB");
  assert.equal(navVaultConfig({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "fm/stocklana-nav-vault-f1" }).enabled, false);
  assert.equal(navVaultConfig({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" }).enabled, false);
  assert.equal(navVaultConfig({}, "stocklana-git-fm-stocklana-nav-vault-f1-kakusans-projects.vercel.app").network, "mainnet-beta", "branch alias host fallback");
  assert.equal(navVaultConfig({ VERCEL_ENV: "production" }, "stocklana-git-fm-stocklana-nav-vault-f1-kakusans-projects.vercel.app").enabled, false);
  assert.equal(navVaultConfig({}, "insiderindex.xyz").enabled, false);
});

test("readiness, position and both prepare routes return one-transaction steps for a flagged index", async () => {
  const { vm, s, deps } = setup();
  const readiness = await (await handleNavReadiness(s.indexId, deps)).json();
  assert.equal(readiness.kind, "nav-vault");
  assert.equal(readiness.depositEnabled, true);
  assert.equal(readiness.redeemEnabled, true);
  assert.equal(readiness.identity.network, "devnet");
  assert.equal(readiness.identity.usdcMint, s.usdc.toBase58());
  assert.equal(readiness.hostEntryFeeBps, 25);
  const deposit = await handleNavDepositPrepare(post({ owner: s.alice.publicKey.toBase58(), amountRaw: "250000000" }), s.indexId, deps);
  assert.equal(deposit.status, 200);
  const step = await deposit.json();
  assert.equal(step.transactions.length, 1);
  assert.equal(step.requires, "user-signature");
  const { VersionedTransaction } = await import("@solana/web3.js");
  const tx = VersionedTransaction.deserialize(Buffer.from(step.transactions[0].messageBase64, "base64"));
  tx.sign([s.alice]);
  vm.must(vm.sendRaw(tx.serialize()), "deposit via route");
  const position = await (await handleNavPosition(new Request(`http://local/api?wallet=${s.alice.publicKey.toBase58()}`), s.indexId, deps)).json();
  assert.equal(position.sharesRaw, step.estimate.sharesRaw);
  assert.equal(position.pendingOperations.length, 0);
  const withdraw = await (await handleNavWithdrawPrepare(post({ owner: s.alice.publicKey.toBase58(), shareAmountRaw: "1000000" }), s.indexId, deps)).json();
  assert.equal(withdraw.transactions.length, 1);
  assert.equal(withdraw.navVault.path, "usdc");
  const claimFor = await handleNavPosition(new Request(`http://local/api?wallet=${s.bob.publicKey.toBase58()}`), s.indexId, deps);
  assert.equal((await claimFor.json()).sharesRaw, "0");
});

test("unflagged index 404s; stale marks close deposits but keep cash out open", async () => {
  const { vm, s, deps } = setup();
  assert.equal((await handleNavReadiness("idx-other", deps)).status, 404);
  vm.advance(301);
  const readiness = await (await handleNavReadiness(s.indexId, deps)).json();
  assert.equal(readiness.depositEnabled, false);
  assert.equal(readiness.redeemEnabled, true);
  const refused = await handleNavDepositPrepare(post({ owner: s.alice.publicKey.toBase58(), amountRaw: "250000000" }), s.indexId, deps);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /stale/);
});

test("FE: the flag routes VaultFlow to NAV endpoints and the wallet-side validator accepts the one-transaction step", async () => {
  const { register } = await import("node:module");
  register("./support/ui-loader.mjs", import.meta.url);
  const { s, deps } = setup();
  process.env.NEXT_PUBLIC_NAV_VAULT_INDEXES = s.indexId;
  const api = await import("../src/lib/frontend/vault-api.ts");
  assert.equal(api.navVaultEnabledFor(s.indexId), true);
  assert.equal(api.navVaultEnabledFor("idx-other"), false);
  assert.equal(api.navVaultLive("idx-other", null), null, "flag off keeps the existing Symmetry gate");
  const readiness = await (await handleNavReadiness(s.indexId, deps)).json();
  assert.equal(api.navVaultLive(s.indexId, readiness), true);
  assert.equal(api.publicIndexCanCashOut(s.indexId, { vaultAddress: readiness.identity.vaultAccount, shareMint: readiness.identity.shareMint, network: "devnet" }), true);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const response = await handleNavDepositPrepare(new Request("http://local/api", { method: "POST", body: String(init?.body) }), s.indexId, deps);
    return response;
  }) as typeof fetch;
  try {
    const step = await api.prepareDeposit(s.indexId, { owner: s.alice.publicKey.toBase58(), amountRaw: "250000000", idempotencyKey: "k" }, "devnet");
    assert.equal(step.transactions.length, 1);
    assert.match(calls[0]!, /\/api\/nav-vault\/idx-theme-mag7-caucus\/deposit\/prepare$/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NEXT_PUBLIC_NAV_VAULT_INDEXES;
  }
});

test("Mag7-size (7 Token-2022 legs) in-kind exit (request + claim) fits ONE v0 transaction with the vault lookup table", async () => {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const program = await import("../src/lib/nav-vault/program.ts");
  const key = () => web3.Keypair.generate().publicKey;
  const vault = program.vaultPda("idx-theme-mag7-caucus");
  const authority = program.authorityPda(vault);
  const legs = Array.from({ length: 7 }, () => { const mint = key(); return { mint, account: program.ata(authority, mint, spl.TOKEN_2022_PROGRAM_ID), tokenProgram: spl.TOKEN_2022_PROGRAM_ID, decimals: 8, weightBps: 1428, price: 1n, reserved: 0n, cachedBalance: 0n }; });
  const usdcMint = key();
  const state: import("../src/lib/nav-vault/program.ts").NavVaultState = { address: vault, admin: key(), keeper: key(), indexSeed: Buffer.alloc(32), indexId: "idx-theme-mag7-caucus", shareMint: program.shareMintPda(vault), usdcMint, usdcAccount: program.ata(authority, usdcMint), feeAccount: key(), lookupTable: null, maxPriceAgeSecs: 60, maxSlippageBps: 100, maxPriceMoveBps: 1500, entryFeeBps: 25, bufferBps: 500, maxDepositUsdc: 0n, requestTimeoutSecs: 600, paused: false, pricesUpdatedAt: 1, pricesUpdatedSlot: 1n, reservedUsdc: 0n, bump: 255, authorityBump: 255, mintAuthorityBump: 255, legs };
  const user = key();
  const request = program.requestPda(vault, user, 1n);
  const ixs = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    spl.createAssociatedTokenAccountIdempotentInstruction(user, program.ata(user, usdcMint), user, usdcMint),
    program.requestWithdrawIx(state, user, { shares: 1n, minUsdc: 0n, nonce: 1n, inKindNow: true }),
    ...legs.map(leg => spl.createAssociatedTokenAccountIdempotentInstruction(user, program.ata(user, leg.mint, leg.tokenProgram), user, leg.mint, leg.tokenProgram)),
    program.claimInKindIx(state, user, { address: request, owner: user }, legs.map((_, i) => i)),
  ];
  const table = new web3.AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: program.vaultLookupAddresses(state) } });
  const compile = (tables: InstanceType<typeof web3.AddressLookupTableAccount>[]) => new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: user, recentBlockhash: user.toBase58(), instructions: ixs }).compileToV0Message(tables));
  assert.throws(() => { const bytes = compile([]).serialize(); if (bytes.length > 1232) throw new Error("too large"); }, "without the LUT it does not fit");
  const tx = compile([table]);
  assert.ok(tx.serialize().length <= 1232);
  const loaded = tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  assert.ok(loaded <= 64);
});

test("an open keeper request shows as a pending withdraw operation on the position until it settles", async () => {
  const { vm, s, deps } = setup();
  const { VersionedTransaction } = await import("@solana/web3.js");
  const { keeperTick, mockVenue } = await import("../src/lib/nav-vault/keeper.ts");
  const sign = async (response: Response) => { const step = await response.json(); const tx = VersionedTransaction.deserialize(Buffer.from(step.transactions[0].messageBase64, "base64")); tx.sign([s.alice]); vm.must(vm.sendRaw(tx.serialize())); return step; };
  await sign(await handleNavDepositPrepare(post({ owner: s.alice.publicKey.toBase58(), amountRaw: "1000000000" }), s.indexId, deps));
  const venue = mockVenue(vm.connection, s.usdc);
  const execute = async (tx: InstanceType<typeof VersionedTransaction>) => { tx.sign([s.keeper]); vm.must(vm.sendRaw(tx.serialize())); return "local"; };
  await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...venue, execute, afterPrices: async () => vm.advance(1), nowSeconds: deps.now });
  const positionOf = async () => (await handleNavPosition(new Request(`http://local/api?wallet=${s.alice.publicKey.toBase58()}`), s.indexId, deps)).json();
  const step = await sign(await handleNavWithdrawPrepare(post({ owner: s.alice.publicKey.toBase58(), shareAmountRaw: (await positionOf()).sharesRaw }), s.indexId, deps));
  assert.equal(step.navVault.path, "request");
  const pending = await positionOf();
  assert.equal(pending.pendingOperations.length, 1);
  assert.equal(pending.pendingOperations[0].kind, "withdraw");
  assert.equal(pending.pendingOperations[0].phase, "CONVERTING");
  await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...venue, execute, afterPrices: async () => vm.advance(1), nowSeconds: deps.now });
  assert.equal((await positionOf()).pendingOperations.length, 0, "settled in USDC by the keeper");
});
