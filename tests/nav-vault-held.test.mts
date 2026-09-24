import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { updatePricesIx } from "../src/lib/nav-vault/program.ts";
import { navVaultConfig } from "../src/lib/nav-vault/config.ts";
import { handleNavDepositPrepare, handleNavPosition, type NavDependencies } from "../src/lib/nav-vault/server.ts";
import { navHeldSlice, tokenAmountText, weightText, type NavHeldBook } from "../src/lib/nav-vault/held.ts";
import { indexDisplayName, sliceDisplayName } from "../src/lib/nav-vault/slices.ts";
import { navVaultVm, seedIndex, PRICE_A, PRICE_B } from "./support/nav-vault-vm.mts";

register("./support/ui-loader.mjs", import.meta.url);
const { HeldNowBook } = await import("../src/components/position-book.tsx");

test("held slice is shares / supply of each free on-chain balance and the free USDC buffer, valued at marks", () => {
  const held = navHeldSlice({
    shares: 250n, supply: 1_000n,
    usdcBalance: 12_000_000n, reservedUsdc: 2_000_000n, // 10 USDC free
    legs: [
      { ticker: "AAPL", mint: "mint-aapl", decimals: 8, price: 200_000_000n, reserved: 0n, balance: 10_000_000n }, // 0.1 AAPL = $20
      { ticker: "NVDA", mint: "mint-nvda", decimals: 8, price: 100_000_000n, reserved: 20_000_000n, balance: 100_000_000n }, // 0.8 free = $80
      { ticker: "AVGO", mint: "mint-avgo", decimals: 8, price: 300_000_000n, reserved: 0n, balance: 0n },
    ],
    markedAt: "2026-09-24T00:00:00.000Z", pricesFresh: true,
  })!;
  assert.deepEqual(held.legs.map(leg => leg.ticker), ["NVDA", "AAPL", "AVGO"], "largest value first");
  assert.deepEqual(held.legs.map(leg => leg.amountRaw), ["20000000", "2500000", "0"]);
  assert.deepEqual(held.legs.map(leg => leg.valueUsdc), ["20", "5", "0"]);
  assert.deepEqual(held.usdc, { amountRaw: "2500000", valueUsdc: "2.5", weightBps: 909 });
  assert.equal(held.totalUsdc, "27.5");
  assert.deepEqual(held.legs.map(leg => leg.weightBps), [7272, 1818, 0]);
  assert.equal(held.markedAt, "2026-09-24T00:00:00.000Z");
  assert.equal(held.pricesFresh, true);
  assert.equal(navHeldSlice({ shares: 0n, supply: 1_000n, usdcBalance: 1n, reservedUsdc: 0n, legs: [] }), null, "no shares, no book");
  assert.equal(navHeldSlice({ shares: 5n, supply: 0n, usdcBalance: 1n, reservedUsdc: 0n, legs: [] }), null, "empty supply, no book");
});

test("token amounts and weights read as human numbers", () => {
  assert.equal(tokenAmountText("2500000", 8), "0.025");
  assert.equal(tokenAmountText("123456789012", 8), "1,234.56789");
  assert.equal(tokenAmountText("1", 8), "<0.000001");
  assert.equal(tokenAmountText("0", 8), "0");
  assert.equal(tokenAmountText("9975000", 6), "9.975");
  assert.equal(tokenAmountText("nope", 6), "—");
  assert.equal(weightText(7272), "72.7%");
  assert.equal(indexDisplayName("Nancy P Index · InsiderIndex"), "Nancy P Index");
  assert.equal(sliceDisplayName("insiderindex-nancy-pelosi"), "Nancy P Index");
  assert.equal(sliceDisplayName("idx-theme-mag7-caucus"), "Mag7 Caucus");
});

test("position API returns the wallet's held slice from on-chain balances and the index display name", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm, "insiderindex-nancy-pelosi");
  vm.must(vm.send([updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A, PRICE_B])], s.keeper));
  vm.advance(1);
  const deps: NavDependencies = {
    config: () => navVaultConfig({ STOCKLANA_NAV_VAULT_INDEXES: s.indexId, STOCKLANA_NAV_VAULT_NETWORK: "devnet" }),
    connection: () => vm.connection,
    now: () => Number(vm.svm.getClock().unixTimestamp),
    slice: async () => ({ indexId: s.indexId, totalLegs: 2, tradableLegs: 2, disclosedWeightBps: 10_000, eligible: true, excluded: [],
      vaultLegs: [{ ticker: "AAPL", mint: s.legA.toBase58(), disclosedWeightBps: 6000, targetWeightBps: 6000 }, { ticker: "NVDA", mint: s.legB.toBase58(), disclosedWeightBps: 4000, targetWeightBps: 4000 }] }),
  };
  for (const who of [s.alice, s.bob]) {
    const step = await (await handleNavDepositPrepare(new Request("http://local/api", { method: "POST", body: JSON.stringify({ owner: who.publicKey.toBase58(), amountRaw: "100000000" }) }), s.indexId, deps)).json();
    const tx = VersionedTransaction.deserialize(Buffer.from(step.transactions[0].messageBase64, "base64"));
    tx.sign([who]);
    vm.must(vm.sendRaw(tx.serialize()), "deposit");
  }
  // Inventory the keeper would have bought: 0.1 A ($20) and 0.05 B ($20) in the vault authority's accounts.
  vm.mintTo(s.admin, s.legA, s.accounts.authority, 100_000n);
  vm.mintTo(s.admin, s.legB, s.accounts.authority, 5_000_000n, TOKEN_2022_PROGRAM_ID);
  const position = await (await handleNavPosition(new Request(`http://local/api?wallet=${s.alice.publicKey.toBase58()}`), s.indexId, deps)).json();
  assert.equal(position.indexName, "Nancy P Index");
  const supply = BigInt(position.shareSupplyRaw), shares = BigInt(position.sharesRaw);
  assert.ok(shares > 0n && shares < supply, "alice holds a fraction of the vault");
  const held = position.held as NavHeldBook;
  assert.deepEqual(held.legs.map(leg => leg.ticker).sort(), ["AAPL", "NVDA"]);
  const a = held.legs.find(leg => leg.ticker === "AAPL")!, b = held.legs.find(leg => leg.ticker === "NVDA")!;
  assert.equal(a.amountRaw, (100_000n * shares / supply).toString());
  assert.equal(b.amountRaw, (5_000_000n * shares / supply).toString());
  assert.equal(b.decimals, 8);
  const usdcInVault = vm.balance(s.accounts.usdc);
  assert.equal(held.usdc.amountRaw, (usdcInVault * shares / supply).toString());
  const sum = [a.valueUsdc, b.valueUsdc, held.usdc.valueUsdc].reduce((total, value) => total + Math.round(Number(value) * 1e6), 0);
  assert.equal(Math.round(Number(held.totalUsdc) * 1e6), sum);
  assert.ok(Math.abs(a.weightBps + b.weightBps + held.usdc.weightBps - 10_000) <= 3);
  assert.equal(held.pricesFresh, true);
  const none = await (await handleNavPosition(new Request(`http://local/api?wallet=${s.keeper.publicKey.toBase58()}`), s.indexId, deps)).json();
  assert.equal(none.sharesRaw, "0");
  assert.equal(none.held, undefined, "no shares: no held book, never the target mix");
});

test("Held now renders each held leg, the USDC buffer, weights and the total", () => {
  const held: NavHeldBook = {
    legs: [
      { ticker: "NVDA", mint: "mint-nvda", decimals: 8, amountRaw: "2000000", valueUsdc: "3.51", weightBps: 3510 },
      { ticker: "AAPL", mint: "mint-aapl", decimals: 8, amountRaw: "1500000", valueUsdc: "3.99", weightBps: 3990 },
      { ticker: "AVGO", mint: "mint-avgo", decimals: 8, amountRaw: "0", valueUsdc: "0", weightBps: 0 },
    ],
    usdc: { amountRaw: "498750", valueUsdc: "0.49875", weightBps: 500 },
    totalUsdc: "9.97", markedAt: null, pricesFresh: true,
  };
  const html = renderToStaticMarkup(createElement(HeldNowBook, { held }));
  assert.match(html, /Held now/);
  assert.match(html, /0\.02 NVDA/);
  assert.match(html, /0\.015 AAPL/);
  assert.match(html, /\$3\.51/);
  assert.match(html, /35\.1%/);
  assert.match(html, /Not held yet/);
  assert.match(html, /0\.49875 USDC · cash buffer/);
  assert.match(html, /\$0\.50/);
  assert.match(html, /5\.0%/);
  assert.match(html, /Total/);
  assert.match(html, /\$9\.97/);
  assert.doesNotMatch(html, /unavailable|target mix/i);
  assert.doesNotMatch(html, /values may lag/);
  assert.match(renderToStaticMarkup(createElement(HeldNowBook, { held: { ...held, pricesFresh: false } })), /values may lag/);
});
