"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { PREVIEW_MODE } from "@/lib/frontend/api";
import { PortfolioDonut } from "./portfolio-charts";
import { PersonAvatar } from "./person-avatar";
import { PageError, Skeleton, Breadcrumb, PartyBadge, StockIcon, EmptyState } from "./social/shared";
import { Icon } from "./social/icon";
import type { FomoProfile, PersonIndex, Disclosure } from "@/lib/disclosures/types";
import { formatDate } from "@/lib/format";
import { CopyButton } from "./copy-button";
import { isCrowdIndex, isCountableBuy } from "@/lib/fomo/index-readiness";
import { indexKindLabel } from "./index-card";
import { venueLabel } from "@/lib/venues/label";
import { VAULT_RELEASE } from "@/lib/index-vaults/release";

type IndexPayload = { index: PersonIndex; profile: FomoProfile | null };
export function IndexTicket({ id }: { id: string }) {
  const resource = useResource<IndexPayload>(`/api/indexes/${encodeURIComponent(id)}`);
  const tape = useResource<{ disclosures: Disclosure[] }>("/api/disclosures");
  const index = resource.data?.index;
  if (resource.loading && !index) return <Skeleton />;
  if (resource.error && !index) return <PageError error={resource.error} retry={resource.reload} />;
  if (!index) return <EmptyState title="Index not found." description="This model is unavailable." />;
  const crowd = isCrowdIndex(index);
  const disclosures = (tape.data?.disclosures ?? []).filter(d => isCountableBuy(d) && (crowd ? d.kind === index.kind : d.profileId === index.profileId));
  const latest = [...disclosures].sort((a, b) => Date.parse(b.filedAt) - Date.parse(a.filedAt)).slice(0, 5);
  return <div className="index-page">
    <Breadcrumb label={index.name} />
    <section className="index-page-header">
      <PersonAvatar name={index.name} imageUrl={index.imageUrl} size="xl" />
      <div><span className="eyebrow">ONE INDEX. ONE NATIVE SHARE MINT.</span><h1>{index.name}<span className="accent-dot">.</span></h1>
        <div className="inline-meta">{crowd ? <span className="index-kind">{indexKindLabel(index)}</span> : <PartyBadge party={index.party} kind={index.kind} />}<span>{index.constituents.length} model names</span></div>
        <p>Disclosure-derived model weights, not a verified current brokerage account or actual vault allocation. Native vault investing is not open yet.</p>
      </div>
    </section>
    <div className="notice building-notice" role="status"><Icon name="clock" size={20} /><div><strong>Native vault verification in progress.</strong><p>No deposits, share issuance or rebalances are being submitted. Catalog coverage alone does not prove native mint, oracle or claim readiness.</p></div></div>
    <div className="order-layout"><div className="order-information">
      <section className="panel"><div className="panel-heading"><h2>Model allocation</h2><span className="outlined-pill">{PREVIEW_MODE ? "Example weights" : "Estimated target weights"}</span></div>
        <PortfolioDonut holdings={index.constituents.map(h => ({ ticker: h.ticker, weightPct: h.weightPct, venueSymbol: h.venueSymbol, valueUsd: h.valueUsd }))} title={index.name} unit="names" />
        <div className="holdings-list">{index.constituents.map(h => <div key={h.ticker}><StockIcon ticker={h.ticker} size="sm" /><span><strong>{h.ticker}</strong><small>{venueLabel(h)}</small></span><strong>{(h.weightPct * 100).toFixed(1)}%</strong></div>)}</div>
        <p className="small-text muted">{index.lastDisclosureAt ? `Last disclosure: ${formatDate(index.lastDisclosureAt)}. ` : ""}Eligible-subset model only. The full disclosed book remains on the public profile. Actual native holdings and NAV per share are unavailable until a verified vault exists.</p>
      </section>
      <section className="how-it-works"><span className="mini-label">NATIVE VAULT LIFECYCLE · NOT YET ENABLED</span>
        <div><span>01</span><p><strong>Deployer-created index</strong>Only the deployer initializes and names each listed vault. Investors cannot create vaults.</p></div>
        <div><span>02</span><p><strong>Authorize native entry</strong>USDC enters the native settlement flow; native shares represent ownership. Multiple approvals and unused contribution returns may be required.</p></div>
        <div><span>03</span><p><strong>Targets and redemption</strong>Policy-valid targets and eligible normal rebalances do not require holder signatures. Redemption returns underlying tokens first. Optional wallet-authorized USDC conversion remains disabled.</p></div>
      </section>
      {latest.length ? <section className="panel"><div className="panel-heading"><h3>Copy one trade instead</h3></div><p className="small-text muted">Separate individual-trade feature, not index-share ownership.</p><div className="filer-list compact">{latest.map(d => <div key={d.id} className="filer-row"><Link href={`/p/${encodeURIComponent(d.profileId)}`} className="filer-identity"><strong>{d.insiderName}</strong><span>{d.ticker} · {formatDate(d.filedAt)}</span></Link><CopyButton signalId={d.id} enabled venue={d.venue} label="Copy this buy" /></div>)}</div></section> : null}
    </div><aside className="order-panel"><div className="order-panel-heading"><h2>Index investing unavailable</h2></div>
      <div className="order-summary"><div><span>Host entry fee</span><strong>{VAULT_RELEASE.hostEntryFeeBps} bps (0.25%)</strong></div><div><span>Host exit fee</span><strong>0</strong></div><div><span>Native exit</span><strong>Underlying tokens first</strong></div><div><span>Actual position</span><strong>Not connected</strong></div></div>
      <p className="ticket-disclaimer">Protocol, venue, network and bounty costs are separate. Shares, fees, claims and actual holdings must be verified from native chain state—not an app purchase row. No guaranteed asynchronous minimum shares or aggregate USDC exit floor.</p>
      <p className="notice">Research only. Basket buying is unavailable.</p>
      <Link className="text-button" href="/feed">Copy one print from the feed</Link>
      <Link className="text-button center" href={crowd ? "/" : `/p/${encodeURIComponent(index.profileId)}`}>{crowd ? "Back to all indexes" : "View full disclosed book"}</Link>
    </aside></div>
  </div>;
}
