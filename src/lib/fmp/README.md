# FMP backend contract

**Holdings are the book.** Live model indexes use the latest saved annual holdings, not a trades-only basket. Raw FMP records are never rewritten. Optional saved trades can help resolve a holding’s security identity; their amounts never supply a holdings balance.

## Operator workflow

Use server-only Supabase credentials in `.env.local` and `FMP_API_KEY` or `$HOME/.config/fmp-api-key`. Never expose secrets or raw archives to the browser.

```sh
npm run holdings:ingest                     # list missing-book count; no writes
npm run holdings:ingest -- --save           # ingest missing annual snapshots, Pelosi first
npm run holdings:ingest -- --save --person=P000197
npm run indexes:publish                     # resolve/dry-run; archives FMP search observations, no index writes
npm run indexes:publish -- --publish        # atomically publish holdings-based targets
npm run indexes:publish -- --publish --person=P000197
```

For a new database apply migrations `202609140001` through `202609140004` in order. Existing stores apply **`supabase/migrations/202609140004_holdings_indexes.sql` as owner** (Supabase service credentials cannot do DDL). It adds `publish_fmp_holdings_index`, marks trade-only versions `BLOCKED`, clears their live pointers, and revokes the legacy publishers from `service_role`. Historical definitions, raw rows, snapshots and transactions remain intact. Public reads filter `CANDIDATE` plus `basis: disclosed-holdings`, never trade-only models. No public refresh/publish endpoint exists.

Ingestion uses existing `save_fmp_portfolio` and `raw_batches` plumbing. It calls profile and annual endpoints only; aggregates and histories are `not-requested`. Existing saved activity/aggregate observations are preserved. Missing snapshots do not imply missing trades, and neither trades nor a mint are prerequisites for saving the book. People with empty provider annual responses stay explicitly `no-annual-book`; there is no famous-person mock fallback. The CLI fills the full saved directory, including `P000197` Nancy Pelosi, with bounded concurrency.

## Holdings, identity and weights

- `holdings-index.ts` selects the **latest observed annual document** by reference year, filing date, then stable saved ID. It does not fall back to an older complete year merely because the newest is partial. Multiple filings stay separate; no amendment or household account is silently merged into another document. Reference year-end is not fetch time or verified current market time.
- The full saved book retains every name, type, owner, nullable value/income band, source link and provenance. Stocks/ETFs, options, income, liabilities and other assets remain separate typed views of the same original items, not extra balances to sum.
- `holding-resolution.ts` creates a separate evidence layer, never overwriting `ticker` or any raw holding field. Dedicated source symbols are accepted. Otherwise exact normalized names can use that person’s stock/ETF trade symbols. Otherwise FMP `search-name` supplies candidates: exact issuer name, USD and US exchange, and one unambiguous symbol are required. Account arrows, legal suffixes, common-stock text and parenthesized symbols are formatting; a parenthesized symbol must agree with the candidate, and can corroborate a named class when the candidate omits it. Uncorroborated classes, fuzzy names, multiple symbols and failed searches remain unresolved. No free-text ticker alone authorizes a mapping.
- Successful and excluded resolutions retain original holding records, archived candidate rows/page hashes/ordinals, matching trade IDs, resolution method, and catalog token. Search observations are persisted before publication and reused across runs. The owner RPC checks saved annual-item membership and archived search/person-trade evidence.
- Catalog matching uses `preferredToken()` only: xStock first, Backpack otherwise. No hand-added mints; options are never substituted with their underlying stock. Unknown symbols and nontradable names remain on the book.
- Membership and sizing come **only from that snapshot’s holdings**. Mapped closed value-band midpoints are summed by mint. If any mapped holding lacks a usable positive closed band, the entire mapped basket uses labelled equal weights. Provider scalar estimates, income and trade bands never fill missing values. Largest-remainder rounding sums to 10,000 bps with a one-bp minimum per mapped name.
- Partial snapshots can publish, but keep their actual completeness/issues in the definition and UI. The target is normalized over mapped observed holdings only, not claimed as the whole portfolio. No performance, NAV, share quantities, net worth, policy or execution approval is invented.

Publication uses a stable content hash and an atomic service-only owner RPC: validate source evidence, save the definition/constituents, allocate the version and update live status/pointer in one transaction. Repeating an identical definition is idempotent. Replaced versions are `BLOCKED`, not deleted. `CANDIDATE` means published model, **not** permission to execute.

## Layers and public reads

- `client.ts`: Node-only bounded FMP transport, key-file fallback and injectable raw archive. Without an injected archive, capture persistence is skipped; there is no filesystem archive or disk fallback. Operator ingestion/search injects `ingest.ts`’s Supabase raw capture. `server.ts` protects runtime credentials with `server-only`.
- `types.ts` / `fmp-parse.ts`: pure source normalization and annual document versions; no env/fetch/aliases in parsers. Legacy `indexInput` still exposes the latest **complete** annual equity/ETF source input, not the published model. `publishedIndex` is the authoritative latest observed holdings target.
- `service.ts`: injectable FMP source service; `portfolio(id, { holdingsOnly: true })` skips optional sources. `ingest.ts`: raw capture plus save adapter that preserves optional histories.
- `holding-resolution.ts` / `holdings-index.ts` / `publish.ts`: evidenced identity, holdings target builder, atomic publication. `trade-index.ts` remains a historical/legacy utility, not the live product or default CLI.
- `store.ts` / `http.ts`: Supabase-only reads and executable HTTP handlers. REST pages are exhausted. Missing service config returns 503; storage errors safe 502; invalid IDs 400; absent people 404. Responses are `private, no-store` with saved timestamps. No FMP network calls on public reads.

`GET /api/people?q=...` returns the complete saved directory before case-insensitive name/ID/state/party filtering (200-character max), `bookState`, `publishedIndexHash`, coverage, pagination and partial metadata. No featured-person or active-member cap.

`GET /api/people/[id]/portfolio` returns saved `person`, `snapshots`, `indexInput`, `activity`, `annualAggregates`, per-source `ingestion`, completeness/state, catalog observations and `publishedIndex`. Uningested people stay `not-ingested`. Home links to `/p/[stable FMP ID]` and `/indexes/fmp-[hash]`; the person page displays the full saved book including unresolved names and separate derived mappings. `GET /api/published-indexes/[hash]` returns a currently published holdings target; retired trade-only or superseded versions are not live targets.

## Person portfolio presentation

`src/components/fmp-portfolio.tsx` keeps the Pelosi Tracker layout on `/p/[id]`: identity, statistics, historical-performance area, all disclosed holdings, published allocation, and dated trade history beside a fail-closed Invest panel. Annual rows render independently of publication and activity. The filing selector keeps all years/versions accessible without adding them together. Tickers and xStock/Backpack venues come from published holding-ID evidence as a presentation overlay; mutual funds and no-mint names remain disclosed-only. The pie and target weights use persisted constituents, never invented annual-row weights. No quotes or verified simulation/benchmark series are supplied, so those areas remain explicitly unavailable.

`index-name.ts` owns canonical `Firstname L Index` names; only collisions in the full saved directory append the FMP ID. Directory, portfolio and published-target APIs keep the same name outside the immutable hash. Follow is device-local browser storage with no alerts or automatic execution. Invest means USDC into a vault for its share token, not stock swaps; no executable vault deposit is connected.

## Transport and completeness

Stable endpoints: `senate-profile`, `senate-net-worth`, `senate-net-worth-aggregated`, `house-trades-by-id`, `senate-trades-by-id`, `house-latest`, `senate-latest`, `search-name`. Both chambers use **`senateID`**. Paginated endpoints continue from page zero until empty, including after short pages. Repeated parsed-page hashes, 2,000-page guard, request/archive errors prevent `complete`; repeated observations are archived but not appended twice. Identical rows within a page retain multiplicity via ordinals. Aggregates and bounded search candidates are unpaginated.

Requests time out at 25 seconds, forbid redirects and retry network/429/5xx at most twice. Retry-After above 30 seconds fails instead of hammering. Upstream errors or malformed JSON are not successful empty results. All captured bodies are credential-redacted before hashing; params never contain credentials. Archive/ingestion never writes the app disk, including on read-only Vercel functions. Supabase captures preserve exact redacted body bytes, timestamp, params and SHA-256; callers without an archive skip persistence. An explicitly configured archive’s storage failure still fails ingestion rather than silently skipping or falling back to disk.

Completeness describes endpoint termination and normalized metadata, not verification of every original government PDF page. Missing dates/links/sections, identity mismatch, unknown forms and unreconciled document versions stay partial. `year` gives calendar-year-end `referenceDate`; `availableAt` remains null. Activity retains original transaction/disclosure dates and dollar bands, including old trades disclosed later; `sinceReport` uses transaction date relative to the legacy complete annual input. No background scheduler or trade-to-holdings reconciliation is introduced.

## Tests

`npm test`: `tests/fmp*.test.mts`, `tests/holdings-index.test.mts`, historical `tests/trade-index.test.mts`. Holdings tests execute both the pure builder and the actual migrations/owner RPC in PGlite (PostgreSQL), covering no-trade ingestion, exact/ambiguous identity, issuer preference, partial books, unknown bands, immutable source rows, atomic weights and disabled legacy publication.
