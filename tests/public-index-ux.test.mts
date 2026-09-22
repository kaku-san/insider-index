import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import { getThematicView } from "../src/lib/thematic/views.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { ThematicIndexPage } = await import("../src/components/thematic-index.tsx");
const { VaultFlow } = await import("../src/components/vault-flow.tsx");
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
  assert.match(html, /Enter an amount in USDC\. After wallet approval, a keeper settles your deposit\. Shares may take a short time to appear\./);
  assert.match(html, /Alpha software — experimental; you can lose funds\./);
  assert.match(html, /Minimum is \$0\.03/);
  assert.match(html, /INVEST/);
  assert.doesNotMatch(html, /ENTRY|EXIT|Review investment|Prepare on-chain action|publicFundsEnabled|VAULT_RELEASE|AWAITING_SIGNATURE|raw/);
  assert.doesNotMatch(html, /CYCLE_|Retain the operation|reconcile operation|recovery required/i);
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
  assert.match(html, /1 shares/);
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
  assert.match(html, /0\.000003 shares/);
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
  assert.doesNotMatch(html, /verified share decimals|claim every asset|Exit mechanics/i);
});
