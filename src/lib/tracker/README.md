# PelosiTracker source adapter

Public data semantics and presentation: [docs/data-sources.md](../../../docs/data-sources.md).

## Immutable source buckets

All three handoffs remain verbatim under `data/insiderindex-source-buckets/`:

- `pelositracker-top20-handoff/`: original top-five slice and trades.
- `pelositracker-top20full-handoff/`: full copy-trade books for Pelosi (15) and MTG (76).
- `pelositracker-top20rere-handoff/`: person-page ledgers and `allTickersTraded`, when supplied.

Each has a `MANIFEST.json`; `tests/tracker-handoff.test.mts` guards every byte. Twenty photos mirror to `public/tracker/photos/`. Source date: 2026-09-15. Copy-trade dollar totals, politician-API estimates and vault NAV are separate figures; none is net worth.

## Modules

- `handoff.ts` normalizes the bundle once via `globalState`; no live scrape.
- `tracker-parse.ts` preserves coverage, missing values and anomalies. Unknown trade midpoints remain nullable bands. Senate missing filing statistics are not zero filings.
- `shown-book.ts` compares tracker positions and older annual evidence without summing sources; OTHER never gains invented tickers.
- `tracker-index.ts` derives a separate, research-only tracker model from catalog mints plus observed Raydium USDC pools. Its readiness does not authorize NAV investment.
- `views.ts` composes source views and catalog evidence; `feed.ts` serves paginated research-only disclosures.

Public `/p/[id]` is `src/components/profile-view.tsx`, with Allocation / Moves / About tabs and annual-book preference when available. `tracker-portfolio.tsx` is a separate detailed workspace, not the public profile route. `/indexes/tracker-[bioguide]` remains research-only. Live NAV indexes use their own on-chain readiness and tradable-slice labels.

`npm run raydium:snapshot` generates the shared `src/lib/index-vaults/raydium-pools-mainnet.json`. The snapshot is dated pool evidence, not a live quote. Never edit it or catalog mints by hand.

## Tests

`tracker-handoff`, `tracker-index`, `tracker-ui`, `tracker-api`, `tracker-feed` and `tracker-top20` tests cover manifests, source-specific books, ranges, exclusions, rendering and API behavior offline.
