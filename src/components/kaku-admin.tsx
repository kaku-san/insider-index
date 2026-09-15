"use client";

import { useId, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import {
  KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, canCreateKakuSan, observeKakuSan, prepareKakuSan,
  signPreparedKakuSan, submitKakuSan, type KakuSanStatus, type KakuSanSubmitResult,
} from "@/lib/frontend/kaku-san";
import styles from "./kaku-admin.module.css";

export function KakuAdmin() {
  const wallet = usePrivySolana();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [created, setCreated] = useState<KakuSanSubmitResult | null>(null);
  const [vaultAddress, setVaultAddress] = useState("");
  const [shareMint, setShareMint] = useState("");
  const [report, setReport] = useState<KakuSanStatus | null>(null);
  const version = useRef(0);
  const owner = wallet.mode === "live" && wallet.authenticated ? wallet.solanaAddress : null;
  const allowed = canCreateKakuSan(wallet);
  const refused = !!owner && owner !== KAKU_SAN_DEPLOYER;
  const vaultReady = !!vaultAddress && !!shareMint;

  async function run() {
    if (!allowed || busy || PREVIEW_MODE || !wallet.solanaAddress) return;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    setBusy(true); setStatus("Preparing create…");
    try {
      const creator = wallet.solanaAddress;
      const prepared = await prepareKakuSan({ creator, step: "create" });
      if (!prepared.vault || !prepared.shareMint) throw new Error("Prepare did not return vault and share mint.");
      if (!isCurrent()) return;
      setStatus("Waiting for your signature…");
      const signed = await signPreparedKakuSan(prepared, wallet, isCurrent);
      if (!isCurrent()) return;
      setStatus("Submitting signed create…");
      const result = await submitKakuSan({ creator, step: "create", vault: prepared.vault, shareMint: prepared.shareMint, signedTransactions: signed });
      if (!isCurrent()) return;
      setCreated(result);
      setVaultAddress(result.vault);
      setShareMint(result.shareMint);
      setStatus(`Vault created. Installing the ${KAKU_SAN_ASSETS.length}-stock basket…`);
      for (const asset of KAKU_SAN_ASSETS) {
        if (!isCurrent()) return;
        setStatus(`Adding ${asset.ticker}…`);
        const add = await prepareKakuSan({ creator, step: "add-token", vault: result.vault, shareMint: result.shareMint, mint: asset.mint });
        const addSigned = await signPreparedKakuSan(add, wallet, isCurrent);
        await submitKakuSan({ creator, step: "add-token", vault: result.vault, shareMint: result.shareMint, signedTransactions: addSigned });
      }
      if (!isCurrent()) return;
      setStatus("Setting equal 2000 bps weights…");
      const weights = await prepareKakuSan({ creator, step: "weights", vault: result.vault, shareMint: result.shareMint });
      const weightSigned = await signPreparedKakuSan(weights, wallet, isCurrent);
      await submitKakuSan({ creator, step: "weights", vault: result.vault, shareMint: result.shareMint, signedTransactions: weightSigned });
      if (!isCurrent()) return;
      setStatus("Basket installed. Reading drift versus 2000 bps targets…");
      const observed = await observeKakuSan({ creator, vault: result.vault, shareMint: result.shareMint });
      if (isCurrent()) { setReport(observed); setStatus("Basket installed. This remains an execution test, not a politician filing."); }
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
      const observed = await observeKakuSan({ creator: wallet.solanaAddress, vault: vaultAddress, shareMint });
      if (isCurrent()) { setReport(observed); setStatus(`Drift loaded. Keeper next: ${observed.keeper.next}.`); }
    } catch (error) {
      if (isCurrent()) setStatus(errorText(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <span className={styles.badge}>Execution test · not a politician filing</span>
    <h1 id={`${id}-title`}>{KAKU_SAN.name}</h1>
    <p>Creates one mainnet Symmetry V3 test vault for a fixed equal-weight basket. This is not a politician filing, not a published index, and does not enable public Invest signing.</p>
    <p>Host {KAKU_SAN.hostEntryFeeBps} bps in comes off a deposit; host exit is {KAKU_SAN.hostExitFeeBps}. Share figures are estimated, not guaranteed. This page does not mint shares, accept deposits, or redeem. Exit stays USDC-only and is not enabled here. Raydium CLMM oracles only. Server never holds a key.</p>
    <h2>Basket</h2>
    <ul>{KAKU_SAN_ASSETS.map(asset => <li key={asset.mint}><strong>{asset.ticker}</strong> · {asset.targetWeightBps} bps · <code>{asset.mint}</code> · CLMM <code>{asset.pool}</code></li>)}</ul>
    {wallet.mode === "live" && !owner && <button type="button" disabled={!wallet.ready || busy || PREVIEW_MODE} onClick={() => void wallet.connect().catch(error => setStatus(errorText(error)))}>Connect wallet</button>}
    {refused && <p className={styles.refuse} role="alert">Connected wallet {owner} is refused. Only {KAKU_SAN_DEPLOYER} may create this execution-test vault.</p>}
    {!owner && wallet.mode !== "live" && <p className={styles.refuse} role="alert">A live Solana wallet is required. Fixture wallets cannot create this vault.</p>}
    <button type="button" disabled={!allowed || busy || PREVIEW_MODE} onClick={() => void run()}>{busy ? "Working…" : "Create Kaku San vault"}</button>
    {PREVIEW_MODE && <p>UI preview mode cannot create a vault or sign.</p>}
    {created && <div className={styles.success} role="status">
      <strong>Vault created</strong>
      <dl>
        <dt>Vault</dt>
        <dd><a href={`https://explorer.solana.com/address/${created.vault}`} target="_blank" rel="noreferrer"><code>{created.vault}</code></a></dd>
        <dt>Share mint</dt>
        <dd><a href={`https://explorer.solana.com/address/${created.shareMint}`} target="_blank" rel="noreferrer"><code>{created.shareMint}</code></a></dd>
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
