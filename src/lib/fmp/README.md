# FMP backend contract

Saved FMP books and separate trade-symbol model indexes. No security-name guessing, annual-row rewriting, contract execution or mock fallback. Existing SEC/AInvest tape adapters remain intact. Tests: `npm test` (`tests/fmp*.test.mts`, `tests/trade-index.test.mts`); recordings: `tests/fixtures/fmp`.

## Layers

- `client.ts`: Node-only stable endpoint client and private filesystem archive; header authorization. Runtime entry is protected by `server.ts`'s `server-only` boundary.
- `types.ts`, `fmp-parse.ts`: pure source/normalized records, instrument classification, document versions and catalog mapping.
- `service.ts`: injectable person directory and annual book + activity service.
- `store.ts` / `server.ts`: public reads use saved Supabase `people` / `fmp_store_state` / `index_versions` / `constituents`, never FMP network calls or filesystem archives. REST pages are exhausted explicitly. Saved annual completeness and unresolved names survive unchanged; people not downloaded yet return `not-ingested`. Server service-role credentials are required; missing configuration returns 503, storage failure a safe 502.
- `trade-index.ts` / `publish.ts`: pure trade-symbol target builder and atomic owner-RPC publication, independent of annual completeness. No public write endpoint.
- `http.ts`: executable HTTP handlers used by the Next routes and tests. HTTP responses are `private, no-store`; server source caches retain original fetch timestamps. No arbitrary URL forwarding or public refresh/publish operation.

## Transport and provenance

Stable endpoints: `senate-profile` (directory and `senateID`), `senate-net-worth`, `senate-net-worth-aggregated`, `house-trades-by-id`, `senate-trades-by-id`, `house-latest`, `senate-latest`. Both chambers use **`senateID`**, including House ID requests. Profiles include former members and both chambers. Both history endpoints are loaded for a person so a chamber change does not drop past activity.

Paginated endpoints start at zero and continue until an empty array, even after a short page. Repeated parsed-page hashes, the 2,000-page safety guard, request errors or archive errors prevent `complete`. Repeated pages are archived as observations but not appended a second time. Individual identical rows **within** a page retain multiplicity and distinct ordinals. Aggregate history is a documented unpaginated series, fetched once with `senateID`.

Requests have a 25-second timeout, forbid redirects, and retry network errors/429/5xx at most twice. Retry-After is respected up to 30 seconds; longer waits fail explicitly instead of hammering the provider. Other HTTP errors and unexpected/error-shaped JSON never become a successful empty array. Upstream messages, headers and credential-bearing errors never escape the client. There is no background poller or new scheduler: latest-feed client methods are available for a future authenticated ingestion job.

Archive: `.data/fmp/<sha256>-<observation-uuid>.json`, with endpoint, key-free params, `fetchedAt`, `payloadHash`, `rowCount`, HTTP status and the redacted response body. The hash covers exactly the stored body bytes, not a reconstructed object. Each record points to its source page plus raw row ordinal. The archive preserves fields the normalized API does not currently expose. Files are `0600` inside a `0700` directory and never served under `public/`. The Docker named volume `fmp-data` persists the archive across container replacement. This is an auditable raw store, **not** a database migration or a stale fallback cache; after restart, the app re-fetches source batches. Plan private retention/backups for a long-running deployment.

## Read API

### `GET /api/people?q=...`

Returns `{ source, storage, savedAt, people, count, total, complete, partial, unnormalizedCount, ingestion, coverage }`. Each person includes `bookState` and `publishedIndexHash`. Query searches name, ID, state and party; case-insensitive, maximum 200 characters. The full saved directory is read before filtering. `id` equals the provider's stable ID (`L000397`), not a name slug; name/chamber/active are mutable metadata. No artificial 15-name/ticker cap or active-member-only filter.

`ingestion` reports actual provider pagination independently from normalized coverage. Invalid profiles count toward `unnormalizedCount`, force partial coverage, and remain in the raw archive. Directory membership does not mean book availability or permission to invest.

### `GET /api/people/L000397/portfolio`

Returns:

- `person`, top-level `complete`/`partial`, `bookComplete`, and `state`.
- `snapshots`: **all** retained annual rows grouped by person/year/filing date/source link/form type. Every version keeps `items` and separate `stocks`, `etfs`, `options`, `income`, `liabilities`, `other` collections. Household owner, source name/account text, original nullable bands, scalar provider estimates, debt details and provenance survive. The typed category arrays are views of `items`, **not additional balances to sum**.
- `indexInput`: latest complete annual document's equity/ETF records, including unvalued, unmapped and no-ticker rows. `status: annual-input-only` is not a published or executable model. If no complete version exists, `status: unavailable`, `snapshotId: null`, no constituents invented.
- `activity`: both chamber histories, keeping event, instrument, owner, transaction/disclosure dates and original dollar bands. `sinceReport` compares **transaction date** against the selected annual year-end, and is null without a usable date/reference. The full history remains visible, including older transactions filed later. Activity never rewrites any snapshot.
- `annualAggregates`: separate unreconciled provider estimates by year/category, **not performance** and not an independently verified net-worth total.
- `ingestion.{profile,annual,aggregates,houseActivity,senateActivity}`: status (`complete`, `partial`, `failed`), flags, retained count, source pages and safe machine-readable issues. `activityComplete` also checks normalized date/event metadata.
- `catalog`: live/snapshot feed observation metadata. `items` and activity have independent `token`, `disclosureOnly`, `mappingReason` tags.

`publishedIndex` adds the latest atomically published trade target and persisted constituent weights; it does not replace `indexInput`, snapshots or activity. `storage: supabase` and `savedAt` identify the saved observation. `GET /api/published-indexes/[hash]` reads an immutable target by hash. Home links to `/p/[stable FMP ID]` and `/indexes/fmp-[hash]`; these show saved books, ranges, activity and published targets without NAV/performance claims.

A storage failure returns 502 (503 without configuration); an invalid person ID returns 400; a person absent from the saved directory returns 404. Once a real profile exists, a failed annual/activity/aggregate source returns available records with partial flags and per-source errors, not an invented empty complete portfolio. Unexpected failures return a generic safe 502. `state: annual-source-unavailable` distinguishes an annual fetch failure from an actual empty annual response.

## Completeness and identity limitations

`complete` means the endpoint reached its end condition and required normalized metadata/version checks passed. It is **not** verification against every page of the original government PDF. A later source correction is a new archive observation, not retroactive modification of old raw data.

Annual `year` yields a calendar-year-end `referenceDate` (`YYYY-12-31`); it is not filing date or current market time. `availableAt` remains null because FMP does not provide a verified publication timestamp. `fetchedAt` never substitutes for either.

Document versions with missing dates/links/sections, unknown report types, identity mismatches or multiple filings for one year are partial/unreconciled. We do not decide that an amendment replaces an entire report. If ingestion itself is incomplete, no year is promoted to complete merely because its observed rows happen to look plausible. An older complete year may be selected when a newer year has unresolved versions; its year stays explicit.

Annual live records have **no dedicated ticker**. House `[ST]` and `[EF]` instrument markers classify stock/ETF sections, not verified security identity; apparent tickers in names stay unresolved. A future reviewed security mapping must preserve its evidence rather than treating search-name candidates as permission to buy. Dedicated source symbols can use the existing pure `preferredToken()` resolver (xStock first, Backpack next), but only equity/ETF instruments receive a token tag. Options are never replaced with underlying stock; unmapped and ambiguous rows remain disclosed-only. No new mint addresses are hand-added.

Unknown/open-ended value bounds remain null; scalar FMP `value`/`total` is labelled a provider estimate. The annual parser does not compute point net worth, weights, returns, remaining PTR balances, share quantities or token-to-stock conversion. A published trade model does not enable an Invest action merely by matching a mint.

## Publishing saved trade indexes

Apply `supabase/migrations/202609140001_fmp_store.sql` on a new database, then `202609140002_trade_indexes.sql` as the database owner. Existing populated stores need **only** the second migration. The additive migration permits a null annual snapshot reference for explicitly trade-based definitions and adds service-only `publish_fmp_trade_index`. The existing annual RPC and annual foreign key remain intact. Service-role direct writes remain revoked; definition, source-evidence validation, positive constituent weights (sum 10,000 bps), version allocation and publication are one transaction. Persisted status `CANDIDATE` means **published model**, not policy/execution approval.

With gitignored `.env.local` containing Supabase server credentials:

```sh
npm run indexes:publish                 # dry run, reads only
npm run indexes:publish -- --publish    # publish all saved people with mapped trades
```

The builder uses dedicated symbols on that person's stock/ETF trades, resolves the catalog (xStock first, Backpack second), and groups by mint. It weights summed closed-band midpoints across **all saved buys and sales**; this is gross observed activity, not a holdings balance or a recommendation based only on buys. If any mapped trade has an unknown, open, invalid or zero size band, the whole target uses labelled equal weights across mapped names. Largest-remainder rounding totals exactly 10,000 bps with at least one bp per name. No recent-window or annual-pagination-complete gate is imposed. Trade dates determine the target's period; original dates, IDs, bands, source metadata and exclusion reasons are retained in the hashed definition.

Unknown symbols, non-equity instruments, wrong-person and undated records cannot supply constituents. Exclusions stay in the target evidence; annual names stay on the original book, unresolved. The RPC requires matching saved transaction and catalog-tag evidence; a changed issuer mint requires refreshed ingestion/review, never a hand-added address. Identical evidence and mapping produce the same document/hash and idempotent publication. This operation never writes `people.portfolio`, `disclosed_items`, snapshots or transactions.
