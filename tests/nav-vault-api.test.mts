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

test("Mag7-size (7 Token-2022 legs) in-kind exit fits ONE v0 transaction with the vault lookup table", async () => {
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const program = await import("../src/lib/nav-vault/program.ts");
  const key = () => web3.Keypair.generate().publicKey;
  const vault = program.vaultPda("idx-theme-mag7-caucus");
  const authority = program.authorityPda(vault);
  const legs = Array.from({ length: 7 }, () => { const mint = key(); return { mint, account: program.ata(authority, mint, spl.TOKEN_2022_PROGRAM_ID), tokenProgram: spl.TOKEN_2022_PROGRAM_ID, decimals: 8, weightBps: 1428, price: 1n }; });
  const usdcMint = key();
  const state = { address: vault, admin: key(), keeper: key(), indexSeed: Buffer.alloc(32), indexId: "idx-theme-mag7-caucus", shareMint: program.shareMintPda(vault), usdcMint, usdcAccount: program.ata(authority, usdcMint), maxPriceAgeSecs: 300, maxSlippageBps: 100, pricesUpdatedAt: 1, pricesUpdatedSlot: 1n, entryFeeBps: 25, bufferBps: 500, feeAccount: key(), lookupTable: null, maxDepositUsdc: 0n, bump: 255, authorityBump: 255, mintAuthorityBump: 255, legs };
  const user = key();
  const ixs = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    spl.createAssociatedTokenAccountIdempotentInstruction(user, program.ata(user, usdcMint), user, usdcMint),
    ...legs.map(leg => spl.createAssociatedTokenAccountIdempotentInstruction(user, program.ata(user, leg.mint, leg.tokenProgram), user, leg.mint, leg.tokenProgram)),
    program.withdrawIx(state, user, 1n, 0n, true),
  ];
  const table = new web3.AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: program.vaultLookupAddresses(state) } });
  const compile = (tables: InstanceType<typeof web3.AddressLookupTableAccount>[]) => new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: user, recentBlockhash: user.toBase58(), instructions: ixs }).compileToV0Message(tables));
  assert.throws(() => { const bytes = compile([]).serialize(); if (bytes.length > 1232) throw new Error("too large"); }, "without the LUT a 7-leg in-kind exit does not fit");
  assert.ok(compile([table]).serialize().length <= 1232);
});
