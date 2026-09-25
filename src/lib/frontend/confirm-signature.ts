/**
 * Wait for a submitted wallet signature to confirm on chain. This proves the transaction landed,
 * not that the keeper has settled it: callers keep reading the position for the observed state.
 */
export async function confirmSignature(signature: string, network: "mainnet-beta" | "devnet") {
  const endpoint = network === "devnet" ? "https://api.devnet.solana.com" : `${window.location.origin}/api/rpc`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: `vault-confirm-${attempt}`, method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: true }] }) });
    if (!response.ok) throw new Error("Transaction confirmation is unavailable.");
    const payload = await response.json() as { error?: { message?: string }; result?: { value?: Array<{ confirmationStatus?: string | null; err?: unknown } | null> } };
    if (payload.error) throw new Error(payload.error.message || "Transaction confirmation failed.");
    const status = payload.result?.value?.[0];
    if (status?.err) throw new Error("The wallet transaction failed on chain.");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Transaction confirmation timed out.");
}
