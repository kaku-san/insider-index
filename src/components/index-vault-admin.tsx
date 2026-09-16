"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import {
  KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER,
  applyIndexSubmit, canCreateIndexVault, clearIndexReceipt, discardIndex, listIndexDefinitions,
  loadIndexReceipt, mergeIndexObservation, nextIndexStep, observeIndex, prepareIndex, previewIndexDefinition,
  reconcileIndexCreateDraft, signPreparedIndex, submitIndex,
  type IndexPreview, type IndexReceipt, type IndexSummary,
} from "@/lib/frontend/index-vault";
import styles from "./kaku-admin.module.css";

function pct(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export function IndexVaultAdmin() {
  const wallet = usePrivySolana();
  const id = useId();
  const owner = wallet.mode === "live" && wallet.authenticated ? wallet.solanaAddress : null;
  const allowed = canCreateIndexVault(wallet);
  const refused = !!owner && owner !== KAKU_SAN_DEPLOYER;

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<IndexSummary[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [preview, setPreview] = useState<IndexPreview | null>(null);
  const [receipt, setReceipt] = useState<IndexReceipt | null>(null);
  const version = useRef(0);

  const legMints = preview?.legs.map(leg => leg.mint) ?? [];
  const next = nextIndexStep(receipt, legMints);
  const done = next.step === "done";
  const canDiscard = allowed && !!receipt?.vault && !receipt.created;
  const creatable = preview?.creatable === true;

  const loadList = useCallback(async () => {
    if (!allowed || PREVIEW_MODE || !wallet.solanaAddress) return;
    try {
      setDefinitions(await listIndexDefinitions({ creator: wallet.solanaAddress }));
    } catch (error) {
      setStatus(errorText(error));
    }
  }, [allowed, wallet.solanaAddress]);

  // loadList only setState()s after an async fetch resolves, not synchronously in the effect body.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadList(); }, [loadList]);

  async function loadPreview(indexId: string) {
    setSelected(indexId);
    setPreview(null);
    setReceipt(null);
    setStatus(null);
    if (!indexId || !allowed || PREVIEW_MODE || !wallet.solanaAddress) return;
    setBusy(true);
    try {
      const loaded = await previewIndexDefinition({ creator: wallet.solanaAddress, indexId });
      setPreview(loaded);
      setReceipt(loadIndexReceipt(indexId));
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!allowed || busy || PREVIEW_MODE || !wallet.solanaAddress || !preview || !creatable || done) return;
    const indexId = preview.indexId;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    const creator = wallet.solanaAddress;
    setBusy(true);
    try {
      let current = receipt;
      if (current?.vault) {
        setStatus("Checking the saved vault…");
        try {
          current = mergeIndexObservation(current, await observeIndex({ creator, indexId, vault: current.vault, shareMint: current.shareMint }), legMints);
          if (isCurrent()) setReceipt(current);
        } catch (error) {
          if (current.created) throw error;
        }
      }

      while (isCurrent()) {
        const step = nextIndexStep(current, legMints);
        if (step.step === "done") {
          if (isCurrent()) setStatus("Vault installed and verified. Deposits stay closed until the public Invest release flag is on.");
          return;
        }
        if (step.step === "observe") {
          if (!current) throw new Error("Saved vault required.");
          setStatus("Verifying on-chain composition…");
          current = mergeIndexObservation(current, await observeIndex({ creator, indexId, vault: current.vault, shareMint: current.shareMint }), legMints);
          if (!current.verified) throw new Error("On-chain composition does not match the definition legs, weights and deactivated defaults.");
          if (isCurrent()) setReceipt(current);
          continue;
        }
        if (step.step === "create") {
          setStatus(current?.vault ? "Preparing the saved vault…" : "Preparing create…");
          const prepared = await prepareIndex({ creator, indexId, step: "create" });
          current = reconcileIndexCreateDraft(current, prepared);
          if (isCurrent()) setReceipt(current);
          if (!isCurrent()) return;
          setStatus("Waiting for your signature…");
          const signed = await signPreparedIndex(prepared, wallet, isCurrent);
          if (!isCurrent()) return;
          setStatus("Submitting signed create…");
          current = applyIndexSubmit(current, await submitIndex({
            creator, indexId, step: "create", vault: current.vault, shareMint: current.shareMint, signedTransactions: signed,
          }));
          if (isCurrent()) setReceipt(current);
          continue;
        }
        if (!current?.created) throw new Error("Create the vault before installing the composition.");
        const label = step.step === "deactivate-default" ? "Removing default WSOL/USDC Pyth slots…"
          : step.step === "add-token" ? `Adding ${preview.legs.find(leg => leg.mint === step.mint)?.ticker ?? "token"}…`
            : "Setting target weights…";
        setStatus(label);
        const prepared = await prepareIndex({
          creator, indexId, step: step.step, vault: current.vault, shareMint: current.shareMint,
          ...("mint" in step ? { mint: step.mint } : {}),
        });
        const signed = await signPreparedIndex(prepared, wallet, isCurrent);
        current = applyIndexSubmit(current, await submitIndex({
          creator, indexId, step: step.step, vault: current.vault, shareMint: current.shareMint, signedTransactions: signed,
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
    if (!canDiscard || busy || PREVIEW_MODE || !receipt || !wallet.solanaAddress || !preview) return;
    const token = ++version.current;
    const isCurrent = () => token === version.current;
    setBusy(true);
    try {
      setStatus("Waiting for your signature to discard…");
      const prepared = await prepareIndex({ creator: wallet.solanaAddress, indexId: preview.indexId, step: "create" });
      const signed = await signPreparedIndex(prepared, wallet, isCurrent);
      if (!isCurrent()) return;
      setStatus("Discarding the unconfirmed draft…");
      await discardIndex({ creator: wallet.solanaAddress, indexId: preview.indexId, vault: receipt.vault, shareMint: receipt.shareMint, signedTransaction: signed[0] });
      clearIndexReceipt(preview.indexId);
      if (isCurrent()) { setReceipt(null); setStatus("Draft discarded. You can start over."); }
    } catch (error) {
      if (isCurrent()) setStatus(errorText(error));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  const action = done ? "Vault ready"
    : next.step === "create" && !receipt?.vault ? "Create index vault"
      : "Resume composition install";

  return <section className={styles.panel} aria-labelledby={`${id}-title`}>
    <span className={styles.badge}>Deployer admin · create any persisted index</span>
    <h2 id={`${id}-title`}>Create an index vault from a persisted definition</h2>
    <p>Builds one mainnet Symmetry V3 vault from a saved InsiderIndex definition — name, symbol, pool-ready legs and target weights read live from that record, never from constants. The native leg cap is enforced by refusing, never truncating. Creating a vault does not open deposits; the public Invest release flag stays authoritative.</p>
    <p>Raydium oracles only. Default WSOL/USDC Pyth slots are deactivated after create. Only the approved deployer may sign; the server never holds a key. Retries resume the saved vault; they do not create a second one.</p>

    {wallet.mode === "live" && !owner && <button type="button" disabled={!wallet.ready || busy || PREVIEW_MODE} onClick={() => void wallet.connect().catch(error => setStatus(errorText(error)))}>Connect wallet</button>}
    {refused && <p className={styles.refuse} role="alert">Connected wallet {owner} is refused. Only {KAKU_SAN_DEPLOYER} may create index vaults.</p>}
    {!owner && wallet.mode !== "live" && <p className={styles.refuse} role="alert">A live Solana wallet is required. Fixture wallets cannot create a vault.</p>}

    {allowed && <div className={styles.fields}>
      <label htmlFor={`${id}-index`}>Index definition
        <select id={`${id}-index`} value={selected} disabled={busy || PREVIEW_MODE} onChange={event => void loadPreview(event.target.value)}>
          <option value="">Select a persisted index…</option>
          {(definitions ?? []).map(def => <option key={def.indexId} value={def.indexId}>{def.name} · {def.status}{def.vaultAddress ? " · created" : ""}</option>)}
        </select>
      </label>
    </div>}
    {allowed && definitions !== null && definitions.length === 0 && <p role="status">No persisted index definitions are available. Publish one with the top-20 mapping first.</p>}

    {preview && <div className={styles.success} role="status">
      <strong>{preview.name} ({preview.symbol})</strong>
      <p>Status {preview.status}. {preview.legCount} of {preview.nativeTokenCap} leg cap. Host {preview.hostEntryFeeBps} bps in / {preview.hostExitFeeBps} out. Network {preview.network}.</p>
      <p>Deposits: {preview.depositsEnabled ? "gated on" : "closed"} — creating this vault does not open deposits.{preview.depositReason ? ` (${preview.depositReason})` : ""} The public Invest release flag stays authoritative.</p>
      <p>
        Catalog coverage: {preview.coverage.mappedLegCount} of {preview.coverage.tickerCount} tickers ({pct(preview.coverage.mappableByWeightBps)} by weight).
        {" "}Tradable (pool-ready) coverage: {preview.coverage.vaultReadyLegCount} legs ({pct(preview.coverage.poolReadyOfMappedBps)} of the mapped weight).
      </p>
      {preview.refuseReason && <p className={styles.refuse} role="alert">Refused: {preview.refuseReason}</p>}
      {preview.vaultAddress && <p>Vault already recorded: <a href={`https://explorer.solana.com/address/${preview.vaultAddress}`} target="_blank" rel="noreferrer"><code>{preview.vaultAddress}</code></a></p>}
      <table className={styles.drift}>
        <thead><tr><th scope="col">Ticker</th><th scope="col">Target</th><th scope="col">Mint</th><th scope="col">Pool</th></tr></thead>
        <tbody>{preview.legs.map(leg => <tr key={leg.mint}>
          <th scope="row">{leg.ticker}</th>
          <td>{leg.targetWeightBps} bps</td>
          <td><code>{leg.mint}</code></td>
          <td>{leg.kind} <code>{leg.pool}</code></td>
        </tr>)}</tbody>
      </table>
      {preview.poolExcludedLegs.length > 0 && <div>
        <p className={styles.refuse}>No tradable pool — excluded from the vault (not silently re-weighted):</p>
        <ul>{preview.poolExcludedLegs.map(leg => <li key={leg.mint}><strong>{leg.ticker}</strong> · <code>{leg.mint}</code> · {leg.reason}</li>)}</ul>
      </div>}
      <p>Default slots deactivated after create: {KAKU_SAN_DEFAULT_SLOTS.map(slot => slot.ticker).join(", ")}.</p>
    </div>}

    {preview && <div className={styles.actions}>
      <button type="button" disabled={!allowed || busy || PREVIEW_MODE || !creatable || done} onClick={() => void run()}>{busy ? "Working…" : action}</button>
      {canDiscard && <button type="button" disabled={busy || PREVIEW_MODE} onClick={() => void discard()}>Discard draft &amp; start over</button>}
    </div>}

    {PREVIEW_MODE && <p>UI preview mode cannot create a vault or sign.</p>}
    {receipt && <div className={styles.success} role="status">
      <strong>{receipt.verified ? "Vault created & verified" : receipt.created ? "Vault created" : "Vault draft"}</strong>
      <dl>
        <dt>Vault</dt>
        <dd><a href={`https://explorer.solana.com/address/${receipt.vault}`} target="_blank" rel="noreferrer"><code>{receipt.vault}</code></a></dd>
        <dt>Share mint</dt>
        <dd><a href={`https://explorer.solana.com/address/${receipt.shareMint}`} target="_blank" rel="noreferrer"><code>{receipt.shareMint}</code></a></dd>
      </dl>
    </div>}
    {status && <p role="status">{status}</p>}
  </section>;
}
