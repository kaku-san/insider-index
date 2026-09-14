"use client";
import { useState } from "react";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { PageError, Skeleton } from "./social/shared";
import type { StoredPerson } from "@/lib/fmp/store";

export type SavedDirectory = { people: StoredPerson[]; total: number; partial: boolean; savedAt: string | null; storage: string };
export function IndexHome({ initialData }: { initialData?: SavedDirectory } = {}) {
  const resource = useResource<SavedDirectory>("/api/people", initialData);
  const [query, setQuery] = useState("");
  if (resource.error) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={4} />;
  const directory = resource.data;
  const people = directory.people.filter((p) => `${p.name} ${p.id} ${p.party} ${p.state}`.toLowerCase().includes(query.toLowerCase()));
  const published = people.filter((p) => p.publishedIndexHash);
  return <div className="index-home">
    <div className="page-intro"><div><span className="eyebrow">SAVED PUBLIC DISCLOSURES · FMP</span><h1>Disclosures into indexes<span className="accent-dot">.</span></h1></div><Link className="button secondary" href="/feed">Disclosure feed</Link></div>
    <section className="panel fmp-panel"><h2>Published targets. Original books.</h2><p>Explore trade-symbol indexes and the annual disclosures behind each person. Targets describe observed trade activity — including buys and sales — not their current holdings, a funded vault, or live NAV.</p><p className="muted">{directory.total} saved people · {directory.partial ? "Partial directory coverage" : "Directory ingestion complete"} · {directory.savedAt ? `Saved ${new Date(directory.savedAt).toLocaleDateString()}` : "Save time unavailable"}</p><label className="fmp-search">Find a person<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, state, party or ID" type="search" /></label></section>
    <section className="home-section"><div className="section-heading"><div><h2>Published trade indexes</h2><p>Mapped xStock mints first, otherwise Backpack. Partial annual books do not block a trade-based target.</p></div></div>
      {published.length ? <div className="index-grid">{published.map((p) => <article className="panel fmp-panel" key={p.id}><span className="eyebrow">PUBLISHED MODEL TARGET</span><h3>{p.name}</h3><p>{p.chamber} · {p.state ?? "State unavailable"}</p><Link className="button ink" href={`/indexes/fmp-${p.publishedIndexHash}`}>View target weights</Link><p><Link className="text-button" href={`/p/${p.id}`}>Original disclosed book &amp; activity →</Link></p></article>)}</div> : <p className="panel fmp-panel">No published targets match this search. Saved books remain available below.</p>}
    </section>
    <section className="home-section"><div className="section-heading"><div><h2>People &amp; saved books</h2><p>Every disclosed name stays on the book, whether or not a Solana mint exists.</p></div></div><div className="filer-list">{people.map((p) => <Link className="filer-row" key={p.id} href={`/p/${p.id}`}><div><strong>{p.name}</strong><p className="muted">{p.party ?? "Party unavailable"} · {p.state ?? "—"} · {p.bookState === "not-ingested" ? "Book not yet downloaded" : p.bookState} {p.publishedIndexHash ? "· Published index" : ""}</p></div><span aria-hidden="true">→</span></Link>)}</div>{!people.length && <p>No people match this search.</p>}</section>
  </div>;
}
