"use client";
import { useId, useMemo, useRef, useState } from "react";
import { allocationView, ALLOCATION_COLORS, type AllocationInput, type AllocationRow } from "@/lib/frontend/allocation-view";
import { linkedToken, shortMint } from "@/lib/frontend/linked-token";
import { companyNameFor } from "@/lib/frontend/company-logos";
import { formatBps, sliceHeadline, SLICE_FOOTNOTE, withSliceMarks, type NavSlice } from "@/lib/frontend/slice-notes";
import { StockIcon } from "./social/shared";
import { Icon } from "./social/icon";
import styles from "./index-allocation.module.css";

function MintDetails({ item, id }: { item: AllocationInput; id: string }) {
  const token = linkedToken(item);
  const addressInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  async function copyAddress() {
    if (!token.mint) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(token.mint);
      setNotice("Address copied.");
    } catch {
      addressInput.current?.focus();
      addressInput.current?.select();
      setNotice("Address selected. Use your device’s Copy command.");
    }
  }
  return <div className={styles.tokenDetails} id={id}>
    <div className={styles.tokenMeta}><strong>Linked token</strong><span>{token.symbol ? `${token.symbol} · ` : ""}{token.issuer} · {token.networkLabel}</span></div>
    {token.mint ? <>
      <label className={styles.addressLabel} htmlFor={`${id}-mint`}>Token address (Solana mint)</label>
      <div className={styles.addressLine}>
        <input id={`${id}-mint`} ref={addressInput} value={token.mint} readOnly spellCheck={false} aria-label={`${item.ticker} full token mint address`} onFocus={event => event.currentTarget.select()} />
        <button type="button" onClick={copyAddress} aria-label={`Copy ${item.ticker} token address`}><Icon name="copy" size={14} />Copy</button>
      </div>
      <div className={styles.tokenActions}>
        {token.solscan ? <a href={token.solscan} target="_blank" rel="noopener noreferrer">Solscan <Icon name="up" size={13} /></a> : null}
        {token.explorer ? <a href={token.explorer} target="_blank" rel="noopener noreferrer">Solana Explorer <Icon name="up" size={13} /></a> : null}
        {!token.network ? <span>Explorer links appear when the source supplies the network.</span> : null}
        <span className={styles.copyNotice} role="status" aria-live="polite">{notice}</span>
      </div>
      <p className={styles.addressHelp}>This is the linked stock token’s address, not the index vault or your wallet.</p>
    </> : <p className={styles.addressHelp}>{token.unavailable} No substitute address is guessed.</p>}
  </div>;
}

/** One chart + its complete, expandable legend. Replaces both Stocks and Breakdown.
 *  With a NAV vault `slice`, held rows show the vault target weight and every excluded name stays listed with an asterisk + reason. */
export function IndexAllocation({ items: sourceItems, basis = "Published target weights", slice }: { items: AllocationInput[]; basis?: string; slice?: NavSlice | null }) {
  const headline = sliceHeadline(slice);
  const items = useMemo(() => withSliceMarks(sourceItems, slice), [sourceItems, slice]);
  const hasExcluded = items.some(item => item.sliceMark && !item.sliceMark.held);
  const { rows, count, totalBps, denominator, topThreeBps } = allocationView(items);
  const [active, setActive] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const titleId = useId();
  const all = useMemo(() => items.map((item, i) => ({ ...item, key: `${item.ticker}-${i}` }))
    .sort((a, b) => (Number.isFinite(b.weightBps) ? b.weightBps : -1) - (Number.isFinite(a.weightBps) ? a.weightBps : -1) || a.ticker.localeCompare(b.ticker)), [items]);
  const chartKeys = new Set(rows.filter(row => !row.missing && !row.otherCount).map(row => row.key));
  const shownKeys = new Set(rows.filter(row => !row.missing && !row.otherCount).map(row => row.key));
  const extra = all.filter(row => !shownKeys.has(row.key));
  const missing = rows.filter(row => row.missing);
  // Collapsed legend still lists every name the vault does not hold (asterisked), even ones folded into Other.
  const legend: AllocationRow[] = showAll ? [...all, ...missing] : [...rows, ...all.filter(row => !Number.isFinite(row.weightBps) || row.weightBps <= 0 || (row.sliceMark?.held === false && !shownKeys.has(row.key)))];
  // Hover/focus wins; otherwise the expanded holding keeps its chart slice selected so chart and legend agree.
  const focus = active ?? expanded;
  const selected = all.find(row => row.key === focus) ?? rows.find(row => row.key === focus);
  const selectedSlice = focus && chartKeys.has(focus) ? focus : focus && all.some(row => row.key === focus && row.weightBps > 0) ? "other" : focus;
  const hasMore = extra.some(row => Number.isFinite(row.weightBps) && row.weightBps > 0);
  const sliceStarts = rows.reduce<number[]>((starts, row, i) => [...starts, i ? starts[i - 1] + rows[i - 1].weightBps / denominator * 100 : 0], []);
  if (!items.length) return <section className={styles.empty}><h3>Allocation is not available yet.</h3><p>The source has no holdings for this view.</p></section>;
  return <section className={styles.panel} aria-labelledby={titleId}>
    <header className={styles.header}><div><h2 id={titleId}>Allocation</h2><p>{basis}</p>{headline ? <p className={styles.sliceHeadline} data-slice-headline="true">{headline}</p> : null}</div><span className={styles.count}>{items.length} holdings</span></header>
    <div className={styles.body}>
      <div className={styles.chartColumn}>
        <div className={styles.chart} onPointerLeave={() => setActive(null)}>
          <svg viewBox="0 0 280 280" role="img" aria-label={rows.length ? rows.map(row => `${row.otherCount ? "Other holdings" : row.missing ? "Unreported allocation" : companyNameFor(row.ticker, row.name)}: ${(row.weightBps / 100).toFixed(2)}%`).join("; ") : "Weights unavailable. All source holdings are listed alongside."}>
            <circle cx="140" cy="140" r="108" fill="none" stroke="var(--surface-alt)" strokeWidth="31" />
            {rows.map((row, i) => {
              const length = row.weightBps / denominator * 100;
              const start = sliceStarts[i];
              return <circle key={row.key} cx="140" cy="140" r="108" pathLength="100" transform="rotate(-90 140 140)" fill="none" stroke={row.missing ? "var(--border)" : ALLOCATION_COLORS[i % ALLOCATION_COLORS.length]} strokeWidth={selectedSlice === row.key ? 37 : 31} strokeDasharray={`${Math.max(0, length - (rows.length > 1 ? Math.min(.8, length * .12) : 0))} 100`} strokeDashoffset={-start} opacity={focus && selectedSlice !== row.key ? .45 : 1} onPointerEnter={() => setActive(row.key)} />;
            })}
          </svg>
          <div className={styles.center} aria-hidden="true"><strong>{selected && Number.isFinite(selected.weightBps) ? `${(selected.weightBps / 100).toFixed(1)}%` : items.length}</strong><span>{selected ? (selected.ticker === "OTHER" ? "other holdings" : selected.ticker === "UNREPORTED" ? "unreported" : selected.ticker) : "holdings"}</span></div>
        </div>
        {count ? <div className={styles.concentration}><strong>{(topThreeBps / 100).toFixed(1)}%</strong><span>in the largest {Math.min(3, count)} holdings</span></div> : null}
        <p className={styles.chartHint}>Select a holding to inspect its linked token.</p>
      </div>
      <div className={styles.legendColumn}>
        <div className={styles.legendHead}><span>Asset / linked token</span><span>{headline ? "Disclosed weight" : "Weight"}</span></div>
        <div className={styles.legend}>
          {legend.map(row => {
            const index = rows.findIndex(slice => slice.key === row.key);
            const colorIndex = index >= 0 ? index : rows.findIndex(slice => slice.key === "other");
            const token = linkedToken(row);
            const isAggregate = Boolean(row.otherCount || row.missing || row.ticker === "OTHER" || row.ticker === "UNREPORTED");
            const detailsId = `${titleId}-${row.key}-details`;
            const open = expanded === row.key;
            const mark = row.sliceMark;
            const weight = Number.isFinite(row.weightBps) && row.weightBps >= 0 ? row.weightBps : mark && !mark.held && mark.disclosedWeightBps != null ? mark.disclosedWeightBps : null;
            return <div className={styles.legendItem} key={row.key}>
              <button type="button" className={`${styles.holdingButton} ${active === row.key || open ? styles.selected : ""}`} onPointerEnter={() => setActive(row.key)} onPointerLeave={() => setActive(null)} onFocus={() => setActive(row.key)} onBlur={() => setActive(null)} onClick={() => { if (row.otherCount) setShowAll(true); else if (!isAggregate) setExpanded(open ? null : row.key); }} aria-expanded={row.otherCount ? showAll : !isAggregate ? open : undefined} aria-controls={!isAggregate ? detailsId : undefined}>
                <i style={{ background: row.missing ? "var(--border)" : ALLOCATION_COLORS[Math.max(0, colorIndex) % ALLOCATION_COLORS.length] }} />
                {isAggregate ? <span className={styles.unknown}>{row.missing ? "—" : "•••"}</span> : <StockIcon ticker={row.ticker} size="sm" />}
                <span className={styles.name}><strong>{row.otherCount ? "Other holdings" : row.missing ? "Unreported allocation" : row.ticker}{mark && !mark.held ? <sup className={styles.asterisk} aria-label="not held in the vault yet">*</sup> : null}</strong><small>{row.otherCount ? `${row.otherCount} holdings · expand all` : row.missing ? "Not supplied by this source" : `${companyNameFor(row.ticker, row.name)}${row.detail ? ` · ${row.detail}` : ""}`}</small>{mark && !mark.held ? <span className={styles.sliceExcluded} data-slice-excluded="true">*{mark.reason}</span> : null}{mark?.held && mark.targetWeightBps != null ? <span className={styles.sliceHeld} data-slice-held="true">In vault · vault target {formatBps(mark.targetWeightBps)}</span> : null}{!isAggregate ? <span className={styles.linkedHint}>{token.mint ? <><Icon name="copy" size={10} />{shortMint(token.mint)}</> : "Token details"}</span> : null}</span>
                <b>{weight != null ? formatBps(weight) : "—"}</b>
                {!row.missing ? <Icon name="chevron" size={13} className={open ? styles.rotated : ""} /> : <span />}
              </button>
              {!isAggregate && open ? <MintDetails key={row.mint ?? row.key} item={row} id={detailsId} /> : null}
            </div>;
          })}
        </div>
        {hasMore ? <button className={styles.expandAll} type="button" aria-expanded={showAll} onClick={() => { setShowAll(!showAll); setExpanded(null); }}>{showAll ? "Show fewer holdings" : `Show all ${items.length} holdings`}<Icon name="chevron" size={14} className={showAll ? styles.upChevron : styles.downChevron} /></button> : null}
      </div>
    </div>
    {headline && hasExcluded ? <p className={styles.sliceFootnote} data-slice-footnote="true">{SLICE_FOOTNOTE}</p> : null}
    {headline ? <p className={styles.sliceBasis}>Disclosed weight is each name’s share of the disclosed book. Vault target is the weight the vault holds for names it can trade.</p> : null}
    <p className={styles.note}>{totalBps > 10001 ? `Source weights total ${(totalBps / 100).toFixed(2)}%; inspect the source before comparing. ` : ""}Allocation is a source snapshot, not your live position. Linked-token addresses come from the source record; source-only holdings are kept visible.</p>
  </section>;
}
