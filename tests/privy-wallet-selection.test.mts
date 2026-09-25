import assert from "node:assert/strict";
import test from "node:test";
import { EXTERNAL_WALLET_REQUIRED, hasEmbeddedOnlySession, selectableSolanaWallets, selectedSolanaWallet, solanaWalletSourceLabel } from "../src/lib/frontend/privy-wallet-selection.ts";

const embedded = { address: "embedded", standardWallet: { isPrivyWallet: true } };
const phantom = { address: "phantom", standardWallet: { isPrivyWallet: false } };
const solflare = { address: "solflare", standardWallet: {} };

test("only external Solana wallets are selectable; Privy's incidental embedded ordering never wins", () => {
  assert.deepEqual(selectableSolanaWallets([embedded, phantom, solflare]).map(wallet => wallet.address), ["phantom", "solflare"]);
  assert.deepEqual(selectableSolanaWallets([embedded]), []);
  assert.equal(solanaWalletSourceLabel(embedded), "Privy embedded");
  assert.equal(solanaWalletSourceLabel({ ...phantom, walletClientType: "phantom" }), "Phantom/external");
  assert.equal(solanaWalletSourceLabel(solflare), "External wallet");
  assert.equal(selectedSolanaWallet([embedded, phantom, solflare], null)?.address, "phantom");
  assert.equal(selectedSolanaWallet([embedded, phantom, solflare], "solflare")?.address, "solflare");
  // An embedded address is never auto-selected, even when Privy reports it first or as the current one.
  assert.equal(selectedSolanaWallet([embedded, phantom], "embedded")?.address, "phantom");
  assert.equal(selectedSolanaWallet([embedded], "embedded"), null);
});

test("an embedded-only Privy session is refused rather than used for money actions", () => {
  assert.equal(hasEmbeddedOnlySession([embedded]), true);
  assert.equal(hasEmbeddedOnlySession([embedded, phantom]), false);
  assert.equal(hasEmbeddedOnlySession([]), false);
  assert.match(EXTERNAL_WALLET_REQUIRED, /Connect an external Solana wallet/);
});
