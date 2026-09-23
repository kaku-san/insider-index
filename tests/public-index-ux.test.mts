import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import { getThematicView } from "../src/lib/thematic/views.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { ThematicIndexPage } = await import("../src/components/thematic-index.tsx");
const { VaultFlow, sharesIncreasedAfterSignature } = await import("../src/components/vault-flow.tsx");
const { WalletConnectSheet } = await import("../src/components/wallet-connect-sheet.tsx");
const { PrivySolanaContext, PrivySolanaProvider } = await import("../src/components/providers/privy-provider.tsx");
const { UIProvider } = await import("../src/components/providers/ui-provider.tsx");

const mag7Vault: PublicVaultDefinition = {
  indexId: "idx-theme-mag7-caucus", kind: "thematic", personSlug: "mag7-caucus", bioguideId: null,
  name: "Mag7 Caucus", symbol: "IITMAGCA", status: "CREATABLE", network: "mainnet-beta",
  weightBasis: "thematic-multi-member-value", depositsEnabled: true, publicFundsEnabled: true,
  depositReason: "all-mapped-legs-carry-an-observed-tradable-pool (still gated by VAULT_RELEASE.publicFundsEnabled)",
  coverage: { tickerCount: 7, mappedLegCount: 7, vaultReadyLegCount: 7, mappableByWeightBps: 10000 },
  provenance: { kind: "thematic", note: "Congress owns the Mag7" },
  legs: [{ ticker: "MSFT", provider: "xstock", mint: "mint-msft", bookWeightBps: 3448, targetWeightBps: 3448, vaultReady: true }],
  unmapped: [], vaultAddress: "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh",
  shareMint: "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4", updatedAt: "2026-09-17T13:33:30Z",
};

function wrap(child: ReturnType<typeof createElement>) {
  return createElement(UIProvider, null, createElement(PrivySolanaProvider, null, child));
}

test("clicking Mag7 shows stocks, breakdown, and Invest on one page", () => {
  const view = getThematicView("idx-theme-mag7-caucus");
  assert.ok(view);
  const html = renderToStaticMarkup(wrap(createElement(ThematicIndexPage, {
    id: "idx-theme-mag7-caucus",
    initialData: { index: view, storage: "static-feed" },
    initialVault: mag7Vault,
  })));
  assert.match(html, /Mag7 Caucus/);
  assert.match(html, /Invest/);
  assert.doesNotMatch(html, /Cash out/, "cash out stays hidden until this connected wallet has Mag7 shares");
  assert.match(html, />Live</);
  assert.match(html, />Stocks</);
  assert.match(html, />Breakdown</);
  assert.match(html, />About</);
  assert.doesNotMatch(html, /Research only|Deposits closed|token mapped|Pool ready|publicFundsEnabled|VAULT_RELEASE|View holdings/);
});

test("Mag7 without public funds hides Invest without paused deposit copy", () => {
  const view = getThematicView("idx-theme-mag7-caucus");
  assert.ok(view);
  const html = renderToStaticMarkup(wrap(createElement(ThematicIndexPage, {
    id: "idx-theme-mag7-caucus",
    initialData: { index: view, storage: "static-feed" },
    initialVault: { ...mag7Vault, publicFundsEnabled: false },
  })));
  assert.doesNotMatch(html, /Deposits are paused/);
  assert.match(html, /This index has a vault\. Investing is not open yet\./);
  assert.doesNotMatch(html, />Invest</);
  assert.match(html, />Stocks</);
  assert.match(html, />Breakdown</);
});

test("a research theme without a vault does not fake Invest", () => {
  const view = getThematicView("idx-theme-silicon-hill");
  assert.ok(view);
  const html = renderToStaticMarkup(wrap(createElement(ThematicIndexPage, {
    id: "idx-theme-silicon-hill",
    initialData: { index: view, storage: "static-feed" },
    initialVault: { ...mag7Vault, indexId: "idx-theme-silicon-hill", name: view.indexName, vaultAddress: null, shareMint: null, depositsEnabled: false },
  })));
  assert.match(html, /Silicon Hill|silicon/i);
  assert.doesNotMatch(html, />Invest</);
  assert.match(html, />Research</);
  assert.doesNotMatch(html, /Research only|publicFundsEnabled|VAULT_RELEASE/);
});

test("invest sheet uses plain language and skips a separate review step", () => {
  const html = renderToStaticMarkup(wrap(createElement(VaultFlow, {
    open: true, onClose() {}, indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus",
    readiness: {
      indexId: "idx-theme-mag7-caucus",
      depositEnabled: false,
      redeemEnabled: true,
      identity: {
        network: "mainnet-beta",
        vaultAccount: mag7Vault.vaultAddress!,
        shareMint: mag7Vault.shareMint!,
        indexId: "idx-theme-mag7-caucus",
      },
    },
  })));
  assert.match(html, /Choose USDC to start a Mag7 auction\. Small amounts may buy only some names or none\./);
  assert.match(html, /Alpha software — experimental; you can lose funds\./);
  assert.match(html, /value="1"/);
  assert.match(html, /USDC in this wallet/);
  assert.match(html, /Minimum is \$1\./);
  for (const preset of [1, 5, 10, 25, 50]) assert.match(html, new RegExp(`>\\$${preset}<`));
  assert.doesNotMatch(html, />\$250</);
  assert.match(html, /INVEST/);
  assert.doesNotMatch(html, /ENTRY|EXIT|Review investment|Prepare on-chain action|publicFundsEnabled|VAULT_RELEASE|AWAITING_SIGNATURE|raw/);
  assert.doesNotMatch(html, /CYCLE_|Retain the operation|reconcile operation|recovery required|public-deposit-amount|Connect your wallet to continue\./i, "Mag7 Invest mounts the one-approval VaultFlow, never the retained cycle wizard");
});

test("Mag7 invest sheet names the same selected wallet used by the header", () => {
  const address = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
  const wallet = {
    ready: true, configured: true, mode: "live" as const, authenticated: true, previewConnection: false, solanaAddress: address,
    solanaWallets: [address], selectSolanaWallet() {}, appId: "test", connectionMethod: "wallet" as const,
    connect: async () => {}, disconnect: async () => {}, signMessage: async () => "", signTransaction: async () => "", signAndSendTransaction: async () => "",
  };
  const html = renderToStaticMarkup(createElement(UIProvider, null, createElement(PrivySolanaContext.Provider, { value: wallet }, createElement(VaultFlow, {
    open: true, onClose() {}, indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus",
  }))));
  assert.match(html, /Investing as/);
  assert.match(html, /C7ye6UvJ…zgCWYQyB/);
});

test("wallet picker identifies external and embedded choices", () => {
  const external = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
  const embedded = "8m9vvWgNey5UR4oeioMtnDgmEKdB8iQmyYVGXCBCnFqH";
  const wallet = {
    ready: true, configured: true, mode: "live" as const, authenticated: true, previewConnection: false, solanaAddress: external,
    solanaWallets: [external, embedded], solanaWalletLabels: { [external]: "Phantom/external", [embedded]: "Privy embedded" }, selectSolanaWallet() {}, appId: "test", connectionMethod: "wallet" as const,
    connect: async () => {}, disconnect: async () => {}, signMessage: async () => "", signTransaction: async () => "", signAndSendTransaction: async () => "",
  };
  const html = renderToStaticMarkup(createElement(PrivySolanaContext.Provider, { value: wallet }, createElement(WalletConnectSheet, { open: true, onClose() {} })));
  assert.match(html, /Phantom\/external/);
  assert.match(html, /Privy embedded/);
  assert.match(html, /Use this wallet/);
});

test("Mag7 invest sheet shows chain share balance as Your position", () => {
  const html = renderToStaticMarkup(wrap(createElement(VaultFlow, {
    open: true, onClose() {}, indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus",
    position: {
      indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner: "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB",
      shareMint: mag7Vault.shareMint!, shareDecimals: 6, sharesRaw: "1000000",
    },
  })));
  assert.match(html, /Your position/);
  assert.match(html, /1,000,000 raw share units/);
  assert.doesNotMatch(html, /0\.00002|1 shares/);
  assert.doesNotMatch(html, /CYCLE_|Retain the operation|reconcile operation/i);
});

test("Mag7 invest sheet keeps dust shares visible", () => {
  const html = renderToStaticMarkup(wrap(createElement(VaultFlow, {
    open: true, onClose() {}, indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus",
    position: {
      indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner: "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB",
      shareMint: mag7Vault.shareMint!, shareDecimals: 6, sharesRaw: "3",
    },
  })));
  assert.match(html, /3 raw share units · 6 decimals/);
  assert.doesNotMatch(html, /0\.000003 shares/);
});

test("shares received requires an increase after this signature, not old dust", () => {
  assert.equal(sharesIncreasedAfterSignature("3", { sharesRaw: "3" }), false);
  assert.equal(sharesIncreasedAfterSignature("3", { sharesRaw: "4" }), true);
  assert.equal(sharesIncreasedAfterSignature("3", { sharesRaw: "bad" }), false);
});

test("Mag7 cash out uses the position's verified dust decimals", () => {
  const html = renderToStaticMarkup(wrap(createElement(VaultFlow, {
    open: true, onClose() {}, indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", mode: "withdraw",
    readiness: { indexId: "idx-theme-mag7-caucus", redeemEnabled: true, identity: { network: "mainnet-beta", vaultAccount: mag7Vault.vaultAddress!, shareMint: mag7Vault.shareMint! } },
    position: {
      indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner: "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB",
      shareMint: mag7Vault.shareMint!, shareDecimals: 6, sharesRaw: "3",
    },
  })));
  assert.match(html, /value="0\.000003"/);
  assert.match(html, /Cash out\./);
  assert.match(html, /1 approval now/);
  assert.match(html, /Shares burn when you sign/);
  assert.match(html, /leftover stocks and USDC/);
  assert.match(html, /not a share refund/);
  assert.doesNotMatch(html, /verified share decimals|claim every asset|Exit mechanics/i);
});

test("Mag7 fill check stays on a human line and enables Invest only after it passes", async () => {
  const { humanPrepareMessage, prepareCheckControl, MAG7_CANNOT_FILL, MAG7_FILL_CHECK, CASH_OUT_CHECK } = await import("../src/lib/frontend/position-basket.ts");
  assert.equal(humanPrepareMessage(new Error(MAG7_CANNOT_FILL), "deposit"), "This amount cannot buy Mag7 right now.");
  assert.equal(humanPrepareMessage(new Error("Error: boom\n    at quote (route.ts:1:1)"), "deposit"), "Mag7 could not be checked. Try that amount again.");
  assert.equal(humanPrepareMessage(Object.assign(new Error("QUOTE_TIMEOUT"), { name: "TimeoutError" }), "withdraw"), "Cash out could not be checked in time. Try again.");
  assert.deepEqual(prepareCheckControl("deposit", "checking", true), { label: MAG7_FILL_CHECK, enabled: false, status: MAG7_FILL_CHECK });
  assert.deepEqual(prepareCheckControl("deposit", "ready", true), { label: "Invest", enabled: true, status: null });
  assert.equal(prepareCheckControl("deposit", "blocked", true).enabled, false);
  assert.deepEqual(prepareCheckControl("withdraw", "checking", true).label, CASH_OUT_CHECK);
  assert.equal(prepareCheckControl("withdraw", "ready", true).enabled, true);
});

test("position book shows filled names and marks the rest not held", async () => {
  const { PositionBook, CashOutAssetList } = await import("../src/components/position-book.tsx");
  const html = renderToStaticMarkup(createElement(PositionBook, {
    title: "Held now",
    note: "2 of 7 target names are in the vault. Missing names are not held.",
    filled: [{ ticker: "AAPL", mint: "mint-aapl" }, { ticker: "MSFT", mint: "mint-msft" }],
    missing: [{ ticker: "NVDA", mint: "mint-nvda" }],
  }));
  assert.match(html, /Held now/);
  assert.match(html, /AAPL/);
  assert.match(html, /MSFT/);
  assert.match(html, /NVDA/);
  assert.match(html, /Not held/);
  assert.doesNotMatch(html, /Target mix/);
  const pending = renderToStaticMarkup(createElement(PositionBook, {
    title: "Bought so far",
    note: "This auction has not minted shares.",
    filled: [{ ticker: "AAPL", mint: "mint-aapl" }],
    missing: [{ ticker: "NVDA", mint: "mint-nvda" }],
    state: "bought",
  }));
  assert.match(pending, /Bought/);
  assert.match(pending, /Not bought yet/);
  assert.doesNotMatch(pending, /Held|Not held/);
  const receipt = renderToStaticMarkup(createElement(CashOutAssetList, {
    heading: "Sent to your wallet",
    note: "Unsold stocks and USDC are sent to your wallet. This is not a share refund.",
    assets: [{ mint: "mint-aapl", label: "AAPL", amountRaw: "5", kind: "stock" }, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC", amountRaw: "2500000", kind: "usdc" }],
  }));
  assert.match(receipt, /Sent to your wallet/);
  assert.match(receipt, /AAPL · 5 raw/);
  assert.match(receipt, /2\.5 USDC/);
  assert.match(receipt, /not a share refund/);
});

test("prepared quotes are bound to owner, network, mode, and raw amount", async () => {
  const { prepareRequestKey } = await import("../src/lib/frontend/position-basket.ts");
  const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
  const prepared = prepareRequestKey({ owner, network: "mainnet-beta", mode: "deposit", amountRaw: "1000000" });
  assert.equal(prepared, prepareRequestKey({ owner, network: "mainnet-beta", mode: "deposit", amountRaw: "1000000" }));
  assert.notEqual(prepared, prepareRequestKey({ owner, network: "mainnet-beta", mode: "deposit", amountRaw: "5000000" }));
  assert.notEqual(prepared, prepareRequestKey({ owner, network: "devnet", mode: "deposit", amountRaw: "1000000" }));
  assert.notEqual(prepared, prepareRequestKey({ owner, network: "mainnet-beta", mode: "withdraw", amountRaw: "1000000" }));
});

test("completed cash out does not present the pre-clear holdings as delivered", async () => {
  const { CashOutDeliveryStatus } = await import("../src/components/position-book.tsx");
  const html = renderToStaticMarkup(createElement(CashOutDeliveryStatus, {
    finished: true,
    pendingNote: "Pending holdings",
    assets: [{ mint: "mint-aapl", label: "AAPL", amountRaw: "5", kind: "stock" }],
  }));
  assert.match(html, /Cash out complete — check your wallet\./);
  assert.doesNotMatch(html, /AAPL|Sent to your wallet|Pending holdings/);
});
