import assert from "node:assert/strict";
import test from "node:test";
import { selectableSolanaWallets, selectedSolanaWallet } from "../src/lib/frontend/privy-wallet-selection.ts";

const embedded = { address: "embedded", standardWallet: { isPrivyWallet: true } };
const phantom = { address: "phantom", standardWallet: { isPrivyWallet: false } };
const solflare = { address: "solflare", standardWallet: {} };

test("a connected external Solana wallet wins over Privy's incidental embedded-wallet ordering", () => {
  assert.deepEqual(selectableSolanaWallets([embedded, phantom, solflare]).map(wallet => wallet.address), ["phantom", "solflare"]);
  assert.equal(selectedSolanaWallet([embedded, phantom, solflare], null)?.address, "phantom");
  assert.equal(selectedSolanaWallet([embedded, phantom, solflare], "solflare")?.address, "solflare");
  assert.equal(selectedSolanaWallet([embedded], "embedded")?.address, "embedded");
});
