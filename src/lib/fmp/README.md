# FMP backend contract

No UI, contract execution, index publication, security-name guessing or mock fallback is implemented here. Existing SEC/AInvest adapters remain intact. Tests: `npm test` (`tests/fmp.test.mts`); recordings: `tests/fixtures/fmp`.

## Layers

- `client.ts`: Node-only stable endpoint client and private filesystem archive; header authorization. Runtime entry is protected by `server.ts`'s `server-only` boundary.
- `types.ts`, `fmp-parse.ts`: pure source/normalized records, instrument classification, document versions and catalog mapping.
- `service.ts`: injectable person directory and annual book + activity service.
- `server.ts`: shared `globalState()` TTL and in-flight request deduplication; cached source batches are shared by all visitors, not fetched on each view. Daily directory/annual/aggregate refresh, hourly histories, 60-second partial/failure retry window. Normalized directory/portfolio results are shared for one minute via the existing memo cache, then recomputed from cached sources and the current catalog without re-fetching history.
- `http.ts`: executable HTTP handlers used by the Next routes and tests. HTTP responses are `private, no-store`; server source caches retain original fetch timestamps. No arbitrary URL forwarding or public refresh/publish operation.

## Transport and provenance

Stable endpoints: `senate-profile` (directory and `senateID`), `senate-net-worth`, `senate-net-worth-aggregated`, `house-trades-by-id`, `senate-trades-by-id`, `house-latest`, `senate-latest`. Both chambers use **`senateID`**, including House ID requests. Profiles include former members and both chambers. Both history endpoints are loaded for a person so a chamber change does not drop past activity.

Paginated endpoints start at zero and continue until an empty array, even after a short page. Repeated parsed-page hashes, the 2,000-page safety guard, request errors or archive errors prevent `complete`. Repeated pages are archived as observations but not appended a second time. Individual identical rows **within** a page retain multiplicity and distinct ordinals. Aggregate history is a documented unpaginated series, fetched once with `senateID`.

Requests have a 25-second timeout, forbid redirects, and retry network errors/429/5xx at most twice. Retry-After is respected up to 30 seconds; longer waits fail explicitly instead of hammering the provider. Other HTTP errors and unexpected/error-shaped JSON never become a successful empty array. Upstream messages, headers and credential-bearing errors never escape the client. There is no background poller or new scheduler: latest-feed client methods are available for a future authenticated ingestion job.

Archive: `.data/fmp/<sha256>-<observation-uuid>.json`, with endpoint, key-free params, `fetchedAt`, `payloadHash`, `rowCount`, HTTP status and the redacted response body. The hash covers exactly the stored body bytes, not a reconstructed object. Each record points to its source page plus raw row ordinal. The archive preserves fields the normalized API does not currently expose. Files are `0600` inside a `0700` directory and never served under `public/`. The Docker named volume `fmp-data` persists the archive across container replacement. This is an auditable raw store, **not** a database migration or a stale fallback cache; after restart, the app re-fetches source batches. Plan private retention/backups for a long-running deployment.

## Read API

### `GET /api/people?q=...`

Returns `{ source, people, count, total, complete, partial, unnormalizedCount, ingestion, coverage }`. Query searches name, ID, state and party; case-insensitive, maximum 200 characters. The full provider directory is fetched before filtering. `id` equals the provider's stable ID (`L000397`), not a name slug; name/chamber/active are mutable metadata. No artificial 15-name/ticker cap or active-member-only filter.

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

An initial profile/directory failure returns 502 (503 without configuration); an invalid person ID returns 400; a verified complete empty person lookup returns 404. Once a real profile exists, a failed annual/activity/aggregate source returns available records with partial flags and per-source errors, not an invented empty complete portfolio. Unexpected failures return a generic safe 502. `state: annual-source-unavailable` distinguishes an annual fetch failure from an actual empty annual response.

## Completeness and identity limitations

`complete` means the endpoint reached its end condition and required normalized metadata/version checks passed. It is **not** verification against every page of the original government PDF. A later source correction is a new archive observation, not retroactive modification of old raw data.

Annual `year` yields a calendar-year-end `referenceDate` (`YYYY-12-31`); it is not filing date or current market time. `availableAt` remains null because FMP does not provide a verified publication timestamp. `fetchedAt` never substitutes for either.

Document versions with missing dates/links/sections, unknown report types, identity mismatches or multiple filings for one year are partial/unreconciled. We do not decide that an amendment replaces an entire report. If ingestion itself is incomplete, no year is promoted to complete merely because its observed rows happen to look plausible. An older complete year may be selected when a newer year has unresolved versions; its year stays explicit.

Annual live records have **no dedicated ticker**. House `[ST]` and `[EF]` instrument markers classify stock/ETF sections, not verified security identity; apparent tickers in names stay unresolved. A future reviewed security mapping must preserve its evidence rather than treating search-name candidates as permission to buy. Dedicated source symbols can use the existing pure `preferredToken()` resolver (xStock first, Backpack next), but only equity/ETF instruments receive a token tag. Options are never replaced with underlying stock; unmapped and ambiguous rows remain disclosed-only. No new mint addresses are hand-added.

Unknown/open-ended value bounds remain null; scalar FMP `value`/`total` is labelled a provider estimate. This module does not compute point net worth, weights, returns, remaining PTR balances, share quantities or token-to-stock conversion. It cannot enable an Invest action merely by matching a mint.
