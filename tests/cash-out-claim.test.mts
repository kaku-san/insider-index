import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cashOutRequestView, claimRequestKey, positionNeedsOwnerClaim, CLAIM_IN_KIND_ACTION, CLAIM_IN_KIND_NOTE, CONVERTING_NOTE,
} from "../src/lib/frontend/cash-out-claim.ts";

register("./support/ui-loader.mjs", import.meta.url);

const OWNER = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
const REQUEST = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";

const position = (overrides: Record<string, unknown> = {}) => ({
  indexId: "insiderindex-nancy-pelosi",
  owner: OWNER,
  sharesRaw: "0",
  pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CONVERTING", complete: false, nextAction: "The keeper is converting your share of the vault to USDC." }],
  ...overrides,
});

test("an open request exposes the on-chain request id and its observed next step", () => {
  const converting = cashOutRequestView(position());
  assert.equal(converting?.requestId, REQUEST);
  assert.equal(converting?.claimable, false);
  assert.equal(converting?.nextAction, "The keeper is converting your share of the vault to USDC.");
  const claimable = cashOutRequestView(position({ pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CLAIMABLE_IN_KIND", complete: false, nextAction: "Claim your share of the vault in kind." }] }));
  assert.equal(claimable?.claimable, true);
  assert.equal(claimable?.nextAction, "Claim your share of the vault in kind.");
});

test("no request, a finished one, or a malformed id never shows a claim action", () => {
  assert.equal(cashOutRequestView(null), null);
  assert.equal(cashOutRequestView({ pendingOperations: [] }), null);
  assert.equal(cashOutRequestView(position({ pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CONVERTING", complete: true }] })), null);
  assert.equal(cashOutRequestView(position({ pendingOperations: [{ operationId: "not-an-address", kind: "withdraw", phase: "CONVERTING", complete: false }] })), null);
  assert.equal(cashOutRequestView({ pendingOperations: [{ operationId: REQUEST, kind: "deposit", phase: "CONVERTING", complete: false }] }), null);
});

test("a missing observed next step falls back to the plain note for its phase", () => {
  assert.equal(cashOutRequestView(position({ pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CONVERTING", complete: false }] }))?.nextAction, CONVERTING_NOTE);
  assert.equal(cashOutRequestView(position({ pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CLAIMABLE_IN_KIND", complete: false }] }))?.nextAction, CLAIM_IN_KIND_NOTE);
});

test("a prepared claim is bound to owner, network and request id", () => {
  const key = claimRequestKey({ owner: OWNER, network: "mainnet-beta", requestId: REQUEST });
  assert.equal(key, claimRequestKey({ owner: OWNER, network: "mainnet-beta", requestId: REQUEST }));
  assert.notEqual(key, claimRequestKey({ owner: OWNER, network: "devnet", requestId: REQUEST }));
  assert.notEqual(key, claimRequestKey({ owner: REQUEST, network: "mainnet-beta", requestId: REQUEST }));
  assert.notEqual(key, claimRequestKey({ owner: OWNER, network: "mainnet-beta", requestId: OWNER }));
});

test("only a claimable request flags the position for an owner claim", () => {
  assert.equal(positionNeedsOwnerClaim(position()), false);
  assert.equal(positionNeedsOwnerClaim(null), false);
  assert.equal(positionNeedsOwnerClaim({ pendingOperations: [] }), false);
  assert.equal(positionNeedsOwnerClaim(position({ pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CLAIMABLE_IN_KIND", complete: false }] })), true);
});

test("the claim panel shows the converting step with no action before the timeout", async () => {
  const { PrivySolanaContext } = await import("../src/components/providers/privy-provider.tsx");
  const { CashOutClaimPanel } = await import("../src/components/cash-out-claim-panel.tsx");
  const wallet = {
    ready: true, configured: true, mode: "live" as const, authenticated: true, previewConnection: false, solanaAddress: OWNER,
    solanaWallets: [OWNER], selectSolanaWallet() {}, appId: "test", connectionMethod: "wallet" as const,
    connect: async () => {}, disconnect: async () => {}, signMessage: async () => "", signTransaction: async () => "", signAndSendTransaction: async () => "",
  };
  void wallet.signAndSendTransaction;
  const html = renderToStaticMarkup(createElement(PrivySolanaContext.Provider, { value: wallet }, createElement(CashOutClaimPanel, { indexId: "insiderindex-nancy-pelosi", position: position() as never })));
  assert.match(html, /Your cash out is converting/);
  assert.match(html, /The keeper is converting your share of the vault to USDC\./);
  assert.match(html, new RegExp(`data-claim-request="${REQUEST}"`));
  assert.match(html, /unlocks automatically after the vault/);
  assert.doesNotMatch(html, new RegExp(`>${CLAIM_IN_KIND_ACTION}<`));
});

test("the claim panel offers the in-kind action once the request is claimable", async () => {
  const { PrivySolanaContext } = await import("../src/components/providers/privy-provider.tsx");
  const { CashOutClaimPanel } = await import("../src/components/cash-out-claim-panel.tsx");
  const wallet = {
    ready: true, configured: true, mode: "live" as const, authenticated: true, previewConnection: false, solanaAddress: OWNER,
    solanaWallets: [OWNER], selectSolanaWallet() {}, appId: "test", connectionMethod: "wallet" as const,
    connect: async () => {}, disconnect: async () => {}, signMessage: async () => "", signTransaction: async () => "", signAndSendTransaction: async () => "",
  };
  const html = renderToStaticMarkup(createElement(PrivySolanaContext.Provider, { value: wallet }, createElement(CashOutClaimPanel, {
    indexId: "insiderindex-nancy-pelosi",
    position: position({ pendingOperations: [{ operationId: REQUEST, kind: "withdraw", phase: "CLAIMABLE_IN_KIND", complete: false, nextAction: "Claim your share of the vault in kind." }] }) as never,
  })));
  assert.match(html, /Claim your share/);
  assert.match(html, new RegExp(`>${CLAIM_IN_KIND_ACTION}<`));
  assert.match(html, /not a USDC-only exit/);
  assert.doesNotMatch(html, /reload|% complete|\d+%/i);
});
