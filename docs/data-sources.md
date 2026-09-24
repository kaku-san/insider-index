# Data sources and index construction

## What the numbers mean

| Data | Role | Never interpreted as |
| --- | --- | --- |
| FMP saved annual disclosure | Person-book evidence and holdings-based weights | Live wallet balance or current net worth |
| PelosiTracker committed top-20 bundles | Dated positions, source labels and information-only trades | Vault NAV or a sum to add to FMP |
| Multi-member thematic feed | Constructed research baskets with member provenance | A single politician's portfolio |
| Solana issuer catalog | Exact token identity: xStock preferred, verified Backpack `.US` fallback | A guarantee of liquidity |
| Raydium pool snapshot / Jupiter quotes | Dated pool evidence / current execution input | A disclosed holding or historical return |
| NAV vault accounts and marks | User shares, free inventory, reservations and marked value | Politician wealth or copy-trade receipts |

Public `/p/[id]` uses the compact Allocation / Moves / About profile. Allocation prefers the complete annual book and uses tracker holdings when no annual book exists. Every source keeps its date and coverage label. No trade ledger is netted into annual holdings.

## Preserved source evidence

`data/insiderindex-source-buckets/` holds the annual-holdings source and three verbatim PelosiTracker handoffs. Their manifests and `tests/tracker-handoff.test.mts` protect byte integrity; photos are mirrored under `public/tracker/photos/`.

The tracker book is as of **2026-09-15**. Its copy-trade full holdings exist only for Pelosi (15) and MTG (76); other profiles expose a top-five slice plus OTHER. Do not invent tickers for OTHER. Tracker copy-trade dollars, politician-API dollars and vault NAV are distinct measures. FMP annual evidence is older and may be incomplete.

Congressional PTRs report dollar bands: nullable `amountLow` / `amountHigh`, displayed as ranges, not exact execution prices or `$0`. Returns and hit rates remain unavailable without a real dated price series.

## Ingestion and research publication

Saved people/portfolio HTTP reads are Supabase-only; they never trigger FMP crawls or write captures to a deployed app's filesystem. Configure `FMP_API_KEY` server-side and apply `supabase/migrations/*.sql` in filename order to your own database.

```sh
npm run holdings:ingest -- --save
npm run indexes:publish -- --publish
npm run profiles:publish -- --publish
```

These are **data-writing operator commands**, not required for offline tests. Inspect their options and use a separate database for development. The detailed annual-document completeness, identity-resolution and publication contracts are in [`src/lib/fmp/README.md`](../src/lib/fmp/README.md).

Pure person/theme derivation remains in `src/lib/index-vaults/{person-index-map,thematic-index-map}.ts`. Same-company share classes collapse to one catalog-resolved leg, with merged weight and recorded provenance. Research catalog/pool coverage never authorizes a deposit; NAV chain readiness does. The historical research schema's 100-leg cap is not the NAV program's 25-leg limit or operator CLI's 16-leg guard.

## Catalog and liquidity

```sh
npm run catalog:snapshot
npm run raydium:snapshot
```

Snapshots are generated evidence; never hand-add a mint or guessed pool. Raydium candidates include tracker holdings, annual person books **and thematic constituents**. The pool freshness guard distinguishes stale evidence from a current execution quote. Copyable catalog issuers are xStocks and Backpack; Ondo, Superstate and PreStocks are not included.

NAV slice generation (`scripts/nav-vault-slices.mts`) is separate from the full research book. It records excluded names/reasons and renormalizes the retained weights. Published slice metadata is served only when it matches on-chain legs. See [NAV disclosure contract](nav-vault.md#tradable-slices).

## Disclosure feed and separate copy trades

`GET /api/disclosures` serves the committed PelosiTracker/FMP bundle through `src/lib/tracker/feed.ts`, paginated with the documented defaults in that file. Rows are research-only (`tradeEligible: false`); live EDGAR/AInvest lanes are reported off with provenance rather than fetched for the feed.

The EDGAR, AInvest and Form4API adapters remain available for independent ingest workflows, with environment keys in `.env.example`; they are not replaced by this repository cleanup. Individual copy-order and receipt infrastructure remains separate from NAV shares. A copy receipt is transaction history, not an index balance or NAV.
