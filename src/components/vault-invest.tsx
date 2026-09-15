"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePrivySolana, type PrivySolanaWallet } from "./providers/privy-provider";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import { requestDevnetDeposit, signPreparedDevnetDeposit } from "@/lib/frontend/devnet-deposit";
import { canSignDevnetDeposit, DEVNET_TEST_VAULT, devnetUsdcRaw } from "@/lib/index-vaults/devnet-contract";
import type { DevnetDepositPreview } from "@/lib/index-vaults/devnet-contract";
import styles from "./vault-invest.module.css";

export function VaultInvest() {
  const wallet = usePrivySolana();
  // Wallet changes discard all preparation, including late responses from an old session.
  return <DevnetInvest key={`${wallet.mode}:${wallet.authenticated}:${wallet.solanaAddress}`} wallet={wallet} />;
}

function DevnetInvest({ wallet }: { wallet: PrivySolanaWallet }) {
  const id = useId();
  const [amount, setAmount] = useState("0.1");
  const [preview, setPreview] = useState<DevnetDepositPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const version = useRef(0);
  useEffect(() => () => { version.current += 1; }, []);
  let raw: string | null = null;
  try { raw = devnetUsdcRaw(amount); } catch { /* Show inline validation, never coerce/round. */ }
  const owner = wallet.mode === "live" && wallet.authenticated ? wallet.solanaAddress : null;
  const ready = !!owner && canSignDevnetDeposit(preview) && !PREVIEW_MODE;
  async function inspect(sign = false) {
    if (!raw || busy || PREVIEW_MODE) return;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    setBusy(true); setStatus(null);
    try {
      const result = await requestDevnetDeposit({
        network: "devnet", vaultAccount: DEVNET_TEST_VAULT.vaultAccount, shareMint: DEVNET_TEST_VAULT.shareMint,
        owner, amountUsdcRaw: raw, ...(sign && preview ? { expectedStateHash: preview.stateHash } : {}),
      }, sign);
      if (!isCurrent()) return;
      setPreview(result);
      if (sign) {
        await signPreparedDevnetDeposit(result, wallet, isCurrent);
        if (isCurrent()) setStatus("Signed only. No transaction was broadcast; settlement is not enabled.");
      }
    } catch (error) { if (isCurrent()) { setPreview(null); setStatus(errorText(error)); } }
    finally { if (isCurrent()) setBusy(false); }
  }
  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <span className={styles.badge}>Devnet only · execution test</span>
    <h3 id={`${id}-title`}>Preview a native vault deposit</h3>
    <p>This existing test vault is separate from the person’s disclosed book and published index. It is not a politician stock basket or a mainnet investment.</p>
    <p><strong>SDK devnet USDC → native vault shares</strong></p>
    <details><summary>Exact devnet addresses</summary><dl>
      <dt>Vault</dt><dd><a href={`https://explorer.solana.com/address/${DEVNET_TEST_VAULT.vaultAccount}?cluster=devnet`} target="_blank" rel="noreferrer">{DEVNET_TEST_VAULT.vaultAccount}</a></dd>
      <dt>Share mint</dt><dd>{DEVNET_TEST_VAULT.shareMint}</dd>
      <dt>Required USDC mint</dt><dd>{DEVNET_TEST_VAULT.usdcMint}</dd>
    </dl><p>Other test USDC mints are not interchangeable. No vault is created here.</p></details>
    <label htmlFor={`${id}-amount`}>SDK devnet USDC amount</label>
    <input id={`${id}-amount`} inputMode="decimal" value={amount} maxLength={24} aria-invalid={!raw} aria-describedby={!raw ? `${id}-amount-error` : undefined} onChange={event => {
      version.current += 1; setAmount(event.target.value); setPreview(null); setStatus(null); setBusy(false);
    }} />
    {!raw && <p id={`${id}-amount-error`}>Enter a positive amount with up to six decimals.</p>}
    {wallet.mode === "live" && !owner && <button type="button" disabled={!wallet.ready || busy || PREVIEW_MODE} onClick={() => void wallet.connect().catch(error => setStatus(errorText(error)))}>Connect wallet</button>}
    <button type="button" disabled={!raw || busy || PREVIEW_MODE} onClick={() => void inspect()}>{busy ? "Checking native state…" : "Preview devnet deposit"}</button>
    {PREVIEW_MODE && <p>UI preview mode cannot request native deposits or sign.</p>}
    {preview && <div className={styles.observation}>
      <p>Native observation · slot {preview.observedSlot} · {new Date(preview.observedAt).toLocaleTimeString()}</p>
      <dl><dt>Native share supply (raw, 6 decimals)</dt><dd>{preview.shareSupplyRaw}</dd><dt>Your shares (raw)</dt><dd>{preview.shareBalanceRaw ?? "Connect a live wallet"}</dd><dt>Estimated shares received</dt><dd>Unavailable — no verified NAV/settlement quote</dd><dt>Host entry / exit fees</dt><dd>{preview.hostEntryFeeBps} / {preview.hostExitFeeBps} bps</dd></dl>
      <details><summary>Observed native assets (not model weights)</summary><ul>{preview.holdings.map(asset => <li key={asset.mint}><code>{asset.mint}</code>: {asset.amountRaw} raw units · target {asset.weightBps} bps{asset.active ? "" : " · inactive"}</li>)}</ul></details>
      <ul id={`${id}-blockers`}>{preview.prepared.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
    <button type="button" disabled={!ready || busy || !raw} aria-describedby={preview ? `${id}-blockers` : `${id}-safety`} onClick={() => void inspect(true)}>Sign devnet deposit</button>
    <p id={`${id}-safety`}>Signing stays disabled until native readiness is verified. Funding the test vault alone does not open deposits. No stub quotes, individual-stock swap basket, or guaranteed USDC exit.</p>
    <p>Host fees are not all-in fees. Protocol, network, rent, bounty and swap costs are separate and not yet quoted. Native settlement can require multiple stages and recovery.</p>
    {status && <p role="status">{status}</p>}
  </section>;
}
