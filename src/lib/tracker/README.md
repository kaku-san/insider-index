# PelosiTracker top-20 handoff

**Tracker positions are the shown current book. FMP is the older annual disclosure. Trades are information only. Nothing is summed across sources, and no tracker dollar figure is a net worth or a vault NAV.**

## Source bucket (kept verbatim)

`data/insiderindex-source-buckets/pelositracker-top20-handoff/` is the extracted `pelositracker-top20-handoff.zip`: `README.md`, `top20-agent-brief.json` (all 20 profiles + series + news), `top20-directory.json`, `nancy-pelosi.json`, `photos/*.jpg` (20/20). `MANIFEST.json` itemizes every file with size and SHA-256; `tests/tracker-handoff.test.mts` fails if any byte changes or a file goes missing. Photos are mirrored byte-for-byte to `public/tracker/photos/<slug>.jpg`.

Scrape: `pelositracker.app`, `2026-09-15T14:09:48Z`, top 20 by PelosiTracker estimated portfolio value. Slices only: 5 top holdings and ~10 recent trades per person, not every lot ever filed. Bios are one-liners. Senate rows carry no filing statistics (`filingStats.tracked = false`), which is missing tracker coverage, not zero filings.

## Product dataset (no live scrape)

- `handoff.ts` imports the brief JSON at build time and normalizes it once per process (`globalState`). Every one of the 20 people is browsable from the bundle: `/` shelf → `/p/[bioguide]` → `/indexes/tracker-[bioguide]`, plus `GET /api/tracker` and `GET /api/tracker/[id]`.
- `tracker-parse.ts` (pure; no `@/`, env or fetch) types the profiles: identity, photo paths, `portfolio` (value/cash/30-day change, always labelled `TRACKER_VALUE_LABEL`), `filingStats`, `sectors`, `topHoldings`, `recentTrades`, the full `performance` series (leading zero-value points counted, never dropped from data), `news`, `sourceUrl`. Trade amounts are decoded to STOCK Act bands from the tracker's `.5` midpoints (`trackerAmountBand`); unknown midpoints stay `null`. Anomalies (frequency labels instead of dates, a date after the scrape, missing filing status) are flagged and kept, never repaired.
- `shown-book.ts` (pure) builds the mixed shown book: tracker rows first with their percentage and dollar estimate, then FMP annual rows (`annualRowTicker`: publication evidence → source symbol → one unambiguous `(SYMB)`), a name on both sides as one row with both readings. `compareWithFmp` lays tracker top holdings beside the published FMP target by exact ticker (GOOG ≠ GOOGL). There is no combined total anywhere.
- `tracker-index.ts` (pure) builds the **vault-ready tracker-positions index**: a tracker holding joins only with a Solana catalog mint (xStock first, Backpack otherwise) **and** an observed mainnet Raydium USDC pool at or above `MIN_RAYDIUM_POOL_TVL_USD`; everything else is listed under `excluded` with a reason (`no-solana-mint`, `no-raydium-usdc-pool`, `raydium-pool-thin`, `no-tracker-percentage`). Weights are the tracker's position percentages renormalized over the included names to exactly 10,000 bps (largest remainder, 1 bp floor). `tradesUsed` is always `false`; the recent-trade tape and the tracker's dollar total never enter. Readiness is `VAULT_CANDIDATE` with two or more investable names, otherwise `WAIT_READINESS`; `P000197` is the only `firstLiveCandidate`. This is composition readiness only — `fundsEnabled: false`, and `VAULT_RELEASE` still gates public funds. Exit policy (`EXIT_POLICY`): USDC only, no in-kind xStock redemption, disabled until a USDC-out quote exists and the 0 bps host exit fee is what the transaction does.
- `views.ts` (server) composes the person and directory views with the live catalog (`loadSolanaCatalog`, snapshot fallback) and the pool snapshot. Index names use the canonical FMP `indexName` from `index-name.ts` when the person is in the saved directory, otherwise `baseIndexName` over the tracker identity with generational suffixes stripped; the suffix is always `· Tracker positions`.

## Raydium pool evidence

`src/lib/index-vaults/raydium-pools-mainnet.json` is written by `npm run raydium:snapshot` (`scripts/snapshot-raydium-pools.mts`) from Raydium's public pool API: mainnet USDC quote only, CLMM/CPMM programs only (the oracle kinds Symmetry supports), highest TVL wins, unresolved mints recorded. `raydium-pools-mainnet.ts` exposes `mainnetRaydiumPoolFor` / `poolReadiness`. It is evidence of what was observed on `fetchedAt`, not a live quote and not the devnet settlement bindings (`DEVNET_RAYDIUM_POOLS`); never hand-edit it and re-run before any deployer step. No Pyth/Hermes anywhere.

## Presentation rules

`src/components/tracker-portfolio.tsx` sections on `/p/[id]`: shown book, vault-ready index, FMP comparison, sector mix, recent trades (information only), filing stats, tracker value series (no return, no S&P overlay), identity/news; the saved FMP sections follow, labelled "Older annual disclosure · FMP" with the plain-English annual date. Every tracker figure wears `PelosiTracker · as of Sep 15, 2026`. `src/components/tracker-index.tsx` is `/indexes/tracker-[id]` with a disabled Invest rail; `tracker-shelf.tsx` lists all 20 on the home page. `/kaku-admin` remains a separate test person and is untouched.

## Tests

`tests/tracker-handoff.test.mts` (manifest integrity, all 20 normalize, bands/anomalies), `tests/tracker-index.test.mts` (pool snapshot policy, exact bps, Pelosi 6688/1179/1072/1061, exclusions, shown book, comparison), `tests/tracker-ui.test.mts` (rendered labels, dates, trades as info, FMP-missing person, Senate stats gap, index page, home shelf).
