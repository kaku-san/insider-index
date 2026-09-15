"use client";

import { useId, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, canCreateKakuSan, prepareKakuSan, signPreparedKakuSan, submitKakuSan, type KakuSanSubmitResult } from "@/lib/frontend/kaku-san";
import styles from "./kaku-admin.module.css";

export function KakuAdmin() {
  const wallet = usePrivySolana();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [created, setCreated] = useState<KakuSanSubmitResult | null>(null);
  const version = useRef(0);
  const owner = wallet.mode === "live" && wallet.authenticated ? wallet.solanaAddress : null;
  const allowed = canCreateKakuSan(wallet);
  const refused = !!owner && owner !== KAKU_SAN_DEPLOYER;

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
      setStatus("Vault created. Installing the 5-stock basket…");
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
      if (isCurrent()) setStatus("Basket installed. This remains an execution test, not a politician filing.");
    } catch (error) {
      if (isCurrent()) setStatus(errorText(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <span className={styles.badge}>Execution test · not a politician filing</span>
    <h1 id={`${id}-title`}>{KAKU_SAN.name}</h1>
    <p>Creates one mainnet Symmetry V3 test vault for a fixed 5-stock equal-weight basket. This is not a politician filing, not a published index, and does not enable public Invest signing.</p>
    <p>Host {KAKU_SAN.hostEntryFeeBps} bps in / {KAKU_SAN.hostExitFeeBps} out. Raydium CLMM oracles only. Server never holds a key.</p>
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
    {status && <p role="status">{status}</p>}
  </section>;
}
