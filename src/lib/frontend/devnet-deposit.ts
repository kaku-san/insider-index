import { canSignDevnetDeposit, DEVNET_TEST_VAULT } from "../index-vaults/devnet-contract.ts";
import type { DevnetDepositPreview, DevnetDepositRequest } from "../index-vaults/devnet-contract.ts";

type Wallet = {
  mode: "live" | "stub" | "unavailable"; authenticated: boolean; solanaAddress: string | null;
  signTransaction: (transaction: string, network: "devnet") => Promise<string>;
};

export async function requestDevnetDeposit(input: DevnetDepositRequest, prepare = false): Promise<DevnetDepositPreview> {
  const response = await fetch(`/api/vaults/devnet/${prepare ? "prepare" : "preview"}`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await response.json();
  // A prepare 503 can carry an observed, explicitly blocked native preview, not a quote.
  if ((!response.ok && response.status !== 503) || !result.prepared || !result.identity) throw new Error(result.error ?? "Native deposit preview unavailable.");
  if (result.identity.network !== "devnet" || result.identity.vaultAccount !== DEVNET_TEST_VAULT.vaultAccount || result.identity.shareMint !== DEVNET_TEST_VAULT.shareMint || result.owner !== input.owner || result.amountUsdcRaw !== input.amountUsdcRaw) throw new Error("Deposit preview identity mismatch.");
  return result as DevnetDepositPreview;
}

/** Explicit signature only, never sign-and-send. The current release always refuses.
 * Settlement/broadcast/recovery must be implemented before lifting the code-level gate.
 */
export async function signPreparedDevnetDeposit(preview: DevnetDepositPreview, wallet: Wallet, isCurrent: () => boolean): Promise<string> {
  if (!isCurrent() || wallet.mode !== "live" || !wallet.authenticated || !wallet.solanaAddress || wallet.solanaAddress !== preview.owner) throw new Error("Connect the same live wallet and preview again.");
  if (!canSignDevnetDeposit(preview)) throw new Error("Native devnet deposit is not ready for signing.");
  const age = Date.now() - Date.parse(preview.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30_000 || preview.prepared.transactions.length !== 1) throw new Error("Fresh, single-stage preparation required.");
  const step = preview.prepared.transactions[0];
  if (!step.simulation.ok || step.requiredSigners.length !== 1 || step.requiredSigners[0] !== wallet.solanaAddress) throw new Error("Native simulation or signer mismatch.");
  const { VersionedMessage, VersionedTransaction } = await import("@solana/web3.js");
  const message = VersionedMessage.deserialize(Uint8Array.from(atob(step.messageBase64), char => char.charCodeAt(0)));
  const transaction = new VersionedTransaction(message);
  if (!isCurrent()) throw new Error("Wallet or amount changed. Preview again.");
  const signed = await wallet.signTransaction(btoa(String.fromCharCode(...transaction.serialize())), "devnet");
  if (!isCurrent()) throw new Error("Wallet or amount changed. Nothing was submitted.");
  return signed;
}
