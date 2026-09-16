"use client";

import { useId, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import {
  KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER,
  applyKakuSanSubmit, canCreateKakuSan, clearKakuSanReceipt, discardKakuSan, loadKakuSanReceipt,
  mergeKakuSanObservation, nextKakuSanStep, observeKakuSan, observeKakuSanStatus, prepareKakuSan,
  reconcileKakuSanCreateDraft, signPreparedKakuSan, submitKakuSan, type KakuSanReceipt, type KakuSanStatus,
} from "@/lib/frontend/kaku-san";
import styles from "./kaku-admin.module.css";

export function KakuAdmin() {
  const wallet = usePrivySolana();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<KakuSanReceipt | null>(loadKakuSanReceipt);
  const [vaultAddress, setVaultAddress] = useState("");
  const [shareMint, setShareMint] = useState("");
  const [report, setReport] = useState<KakuSanStatus | null>(null);
  const version = useRef(0);
  const owner = wallet.mode === "live" && wallet.authenticated ? wallet.solanaAddress : null;
  const allowed = canCreateKakuSan(wallet);
  const refused = !!owner && owner !== KAKU_SAN_DEPLOYER;
  const next = nextKakuSanStep(receipt);
  const done = next.step === "done";
  const canDiscard = allowed && !!receipt?.vault && !receipt.created;
  const vaultReady = !!vaultAddress && !!shareMint;

  async function run() {
    if (!allowed || busy || PREVIEW_MODE || !wallet.solanaAddress || done) return;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    const creator = wallet.solanaAddress;
    setBusy(true);
    try {
      let current = receipt;
      if (current?.vault) {
        setStatus("Checking the saved vault…");
        try {
          current = mergeKakuSanObservation(current, await observeKakuSan({ creator, vault: current.vault, shareMint: current.shareMint }));
          if (isCurrent()) setReceipt(current);
        } catch (error) {
          if (current.created) throw error;
        }
      }

      while (isCurrent()) {
        const step = nextKakuSanStep(current);
        if (step.step === "done") {
          if (isCurrent()) setStatus("Basket installed. This remains an execution test, not a politician filing.");
          return;
        }
        if (step.step === "observe") {
          if (!current) throw new Error("Saved vault required.");
          setStatus("Verifying on-chain composition…");
          current = mergeKakuSanObservation(current, await observeKakuSan({ creator, vault: current.vault, shareMint: current.shareMint }));
          if (!current.verified) throw new Error("On-chain basket is not the 5 xStocks with Raydium CLMM and deactivated WSOL/USDC.");
          if (isCurrent()) setReceipt(current);
          continue;
        }
        if (step.step === "create") {
          setStatus(current?.vault ? "Preparing the saved vault…" : "Preparing create…");
          const prepared = await prepareKakuSan({ creator, step: "create" });
          current = reconcileKakuSanCreateDraft(current, prepared);
          if (isCurrent()) setReceipt(current);
          if (!isCurrent()) return;
          setStatus("Waiting for your signature…");
          const signed = await signPreparedKakuSan(prepared, wallet, isCurrent);
          if (!isCurrent()) return;
          setStatus("Submitting signed create…");
          current = applyKakuSanSubmit(current, await submitKakuSan({
            creator, step: "create", vault: current.vault, shareMint: current.shareMint, signedTransactions: signed,
          }));
          if (isCurrent()) setReceipt(current);
          continue;
        }
        if (!current?.created) throw new Error("Create the saved vault before installing the basket.");
        const label = step.step === "deactivate-default" ? "Removing default WSOL/USDC Pyth slots…"
          : step.step === "add-token" ? `Adding ${KAKU_SAN_ASSETS.find(asset => asset.mint === step.mint)?.ticker ?? "token"}…`
            : "Setting equal 2000 bps weights…";
        setStatus(label);
        const prepared = await prepareKakuSan({
          creator, step: step.step, vault: current.vault, shareMint: current.shareMint,
          ...("mint" in step ? { mint: step.mint } : {}),
        });
        const signed = await signPreparedKakuSan(prepared, wallet, isCurrent);
        current = applyKakuSanSubmit(current, await submitKakuSan({
          creator, step: step.step, vault: current.vault, shareMint: current.shareMint, signedTransactions: signed,
        }), "mint" in step ? step.mint : undefined);
        if (isCurrent()) setReceipt(current);
      }
    } catch (error) {
      if (isCurrent()) setStatus(errorText(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  async function discard() {
    if (!canDiscard || busy || PREVIEW_MODE || !receipt || !wallet.solanaAddress) return;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    setBusy(true);
    try {
      setStatus("Waiting for your signature to discard…");
      const prepared = await prepareKakuSan({ creator: wallet.solanaAddress, step: "create" });
      const signed = await signPreparedKakuSan(prepared, wallet, isCurrent);
      if (!isCurrent()) return;
      setStatus("Discarding the unconfirmed draft…");
      await discardKakuSan({ creator: wallet.solanaAddress, vault: receipt.vault, shareMint: receipt.shareMint, signedTransaction: signed[0] });
      clearKakuSanReceipt();
      if (isCurrent()) { setReceipt(null); setStatus("Draft discarded. You can start over."); }
    } catch (error) {
      if (isCurrent()) setStatus(errorText(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  async function loadDrift() {
    if (!allowed || busy || PREVIEW_MODE || !wallet.solanaAddress || !vaultReady) return;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    setBusy(true); setStatus("Reading vault drift…");
    try {
      const observed = await observeKakuSanStatus({ creator: wallet.solanaAddress, vault: vaultAddress, shareMint });
      if (isCurrent()) { setReport(observed); setStatus(`Drift loaded. Keeper next: ${observed.keeper.next}.`); }
    } catch (error) {
      if (isCurrent()) setStatus(errorText(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  const action = done ? "Vault ready" : next.step === "create" && !receipt?.vault ? "Create Kaku San vault" : "Resume basket install";

  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <span className={styles.badge}>Execution test · not a politician filing</span>
    <h1 id={`${id}-title`}>{KAKU_SAN.name}</h1>
    <p>Creates one mainnet Symmetry V3 test vault for a fixed 5-stock equal-weight basket. This is not a politician filing, not a published index, and does not enable public Invest signing.</p>
    <p>Host {KAKU_SAN.hostEntryFeeBps} bps in / {KAKU_SAN.hostExitFeeBps} out, shown before you sign. Estimated shares are not guaranteed. This page does not redeem or pay USDC out.</p>
    <p>Raydium CLMM oracles only. Default WSOL/USDC Pyth slots are deactivated after create. Server never holds a key. Retries resume the saved vault; they do not create a second one.</p>
    <h2>Basket</h2>
    <ul>{KAKU_SAN_ASSETS.map(asset => <li key={asset.mint}><strong>{asset.ticker}</strong> · {asset.targetWeightBps} bps · <code>{asset.mint}</code> · CLMM <code>{asset.pool}</code></li>)}</ul>
    {wallet.mode === "live" && !owner && <button type="button" disabled={!wallet.ready || busy || PREVIEW_MODE} onClick={() => void wallet.connect().catch(error => setStatus(errorText(error)))}>Connect wallet</button>}
    {refused && <p className={styles.refuse} role="alert">Connected wallet {owner} is refused. Only {KAKU_SAN_DEPLOYER} may create this execution-test vault.</p>}
    {!owner && wallet.mode !== "live" && <p className={styles.refuse} role="alert">A live Solana wallet is required. Fixture wallets cannot create this vault.</p>}
    <button type="button" disabled={!allowed || busy || PREVIEW_MODE || done} onClick={() => void run()}>{busy ? "Working…" : action}</button>
    {canDiscard && <button type="button" disabled={busy || PREVIEW_MODE} onClick={() => void discard()}>Discard draft &amp; start over</button>}
    {PREVIEW_MODE && <p>UI preview mode cannot create a vault or sign.</p>}
    {receipt && <div className={styles.success} role="status">
      <strong>{receipt.verified ? "Vault created" : "Vault draft"}</strong>
      <dl>
        <dt>Vault</dt>
        <dd><a href={`https://explorer.solana.com/address/${receipt.vault}`} target="_blank" rel="noreferrer"><code>{receipt.vault}</code></a></dd>
        <dt>Share mint</dt>
        <dd><a href={`https://explorer.solana.com/address/${receipt.shareMint}`} target="_blank" rel="noreferrer"><code>{receipt.shareMint}</code></a></dd>
      </dl>
    </div>}
    <h2>Drift</h2>
    <p>After a vault and share mint exist, this page shows on-chain weight drift versus the equal 2000 bps targets. Rebalance is an automated keeper with a dedicated hot wallet, not a Phantom click. Run <code>npm run keeper:kaku-san -- --dry-run</code>; <code>--execute --keypair PATH</code> only on the operator machine. This page does not sign rebalance. The server never holds that key.</p>
    <div className={styles.fields}>
      <label htmlFor={`${id}-vault`}>Vault<input id={`${id}-vault`} value={vaultAddress} onChange={event => setVaultAddress(event.target.value.trim())} autoComplete="off" spellCheck={false} /></label>
      <label htmlFor={`${id}-mint`}>Share mint<input id={`${id}-mint`} value={shareMint} onChange={event => setShareMint(event.target.value.trim())} autoComplete="off" spellCheck={false} /></label>
    </div>
    <div className={styles.actions}>
      <button type="button" disabled={!allowed || busy || PREVIEW_MODE || !vaultReady} onClick={() => void loadDrift()}>Show drift</button>
    </div>
    {report && <div className={styles.success} role="status">
      <strong>Drift versus 2000 bps targets</strong>
      <p>Native token cap {report.nativeTokenCap}. Keeper next: {report.keeper.next}. {report.eligibility.reason}</p>
      <table className={styles.drift}>
        <thead><tr><th scope="col">Asset</th><th scope="col">Target</th><th scope="col">On-chain</th><th scope="col">Drift</th><th scope="col">Amount</th></tr></thead>
        <tbody>{report.drift.map(row => <tr key={row.mint}>
          <th scope="row">{row.ticker ?? "other"}</th>
          <td>{row.targetWeightBps} bps</td>
          <td>{row.onchainWeightBps === null ? "missing" : `${row.onchainWeightBps} bps`}</td>
          <td>{row.driftBps === null ? "—" : `${row.driftBps} bps`}</td>
          <td><code>{row.amountRaw}</code></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {status && <p role="status">{status}</p>}
  </section>;
}
