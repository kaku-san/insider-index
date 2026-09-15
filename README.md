# InsiderIndex

Famous portfolios. Public receipts. Canonical product URL: [https://insiderindex.xyz](https://insiderindex.xyz).

Index-first consumer app: people create discovery, public disclosures create trust, and the person index is the product. Copying one disclosure and owning native index shares remain separate money rails. Basket Buy stays unavailable; vault Sign is fail-closed.

**Track A W0: copy one print from `/feed`, sign with Privy, execute through Jupiter, save the receipt.** Full disclosed books and model indexes remain research-only until a verified native vault prepare path exists. [W0 launch checklist and receipt contract](docs/track-a-w0.md). Consumer frontend contract: [docs/insiderindex-fe/FRONTEND-README.md](docs/insiderindex-fe/FRONTEND-README.md).

This repository is a Next.js App Router app. **Live product:** [https://insiderindex.xyz](https://insiderindex.xyz) (InsiderIndex.xyz). The existing Barely Stable / Hetzner deployment is documented below. SEC EDGAR needs no key and is always live; FMP, AInvest, Form4API, Privy, Jupiter, Helius, and Supabase sit behind env keys so `npm run build` works without secrets.

## Product scope

In V1:

- **SEC EDGAR** is the primary Form 4 source (ticker → CIK → recent `4` filings → XML → open-market P/S). No key.
- **FMP** supplies saved person-first books and separate PTR activity. Home and stable-ID person pages read Supabase; published holdings-based indexes show target weights from the latest saved annual snapshot, with partial coverage labelled and no trade-history prerequisite. See [FMP person backend](#fmp-person-backend).
- **AInvest Congressional Trades** remains the primary House/Senate **legacy tape** source (`AINVEST_API_KEY`, free tier)
- Form4API is a fallback only (`FORM4API_KEY`); labelled mocks only where `STOCKLANA_ALLOW_MOCKS` permits (dev default)
- Home is **indexes first**: published FMP holdings models, then the saved person directory. The raw SEC/AInvest tape remains `/feed`; legacy copy/index routes retain their own readiness gates.
- Every filer gets a **Pelosi-Tracker-style disclosed book** on `/p/[id]`: every ticker on their PTRs / Form 4s (`src/lib/fomo/book.ts`), sized from the reported bands as a range, tradable or not. A profile renders with one holding; basket buying remains unavailable regardless of book size
- Day-1 alternative to research-only baskets: follow the filer and copy one trade (same name, user-signed swap into its Solana mint)
- Buys (and copy-sells) are allowed only against a mint in the **live Solana catalog** — xStocks + Backpack tokenised stocks (see [Buy catalog](#buy-catalog)); names without a mint stay visible in the book but are not copy-eligible
- One-trade copying remains available separately. Native index entry is disabled until deployer setup, settlement and claim-recovery evidence pass
- Performance is never invented: return / hit rate stay `—` until a real dated-trade price series exists
- Native vaults are deployer-created/named; holders authorize entry/redemption, never fund rebalances. Policy-valid strategy/keeper automation is planned but currently read-only; see [native integration status](src/lib/index-vaults/README.md)
- Social frontend: lime editorial discover, party-tinted profiles, person-index tickets, light/dark theme (`src/app` pages + `src/components` + `src/lib/frontend`)

Out of V1:

- Quiver, EODHD, Bloomberg
- Ondo Global Markets as a third venue (its mint list needs a key we do not hold; Jupiter search caps at 20 — we do not invent mints)
- Superstate Opening Bell (KYC-allowlisted wallets), PreStocks (pre-IPO SPVs), Forge / Nasdaq Private
- AMMs, second receipt tokens, custom custody programs and off-chain index ownership ledgers

## Architecture

```
EDGAR Form 4 + AInvest PTRs  →  book per filer (venue-tagged via the Solana catalog)
                             →  inspect one filing  →  USDC amount  →  Jupiter /order
                                                                              user signs in Privy
                                                                              Jupiter /execute
                                                                              position store
```

| Layer | Implementation |
| --- | --- |
| App | Next.js App Router, TypeScript, Tailwind CSS v4, shadcn/ui |
| Auth / wallet | Real `@privy-io/react-auth` Solana when `NEXT_PUBLIC_PRIVY_APP_ID` is set; production fails closed if unavailable |
| Insiders | `src/lib/disclosures/edgar.ts` (+ pure `edgar-parse.ts`) primary; `form4.ts` orchestrates EDGAR → Form4API → mock. Issuer set: `edgarUniverse()` (`EDGAR_UNIVERSE=wide`, `EDGAR_TICKERS`) |
| Person-first Congress | `src/lib/fmp/` — FMP stable person IDs, Supabase raw captures, annual source snapshots and separate activity. No PTR-netted current holdings or fabricated rows. |
| Congress tape | `src/lib/disclosures/ainvest.ts` (+ pure `ainvest-parse.ts`) primary; `congress.ts` orchestrates AInvest → Form4API → mock. AInvest is ticker-scoped (no per-member pull), so the crawl walks `buildCongressUniverse()` (`src/lib/disclosures/universe.ts`) and groups rows by filer |
| Book | `src/lib/fomo/book.ts` (pure): running net of PTR bands per ticker, Form 4 shares-after × price; `insights.ts` tags venue + copy eligibility |
| Buy catalog | `src/lib/venues/solana-catalog.ts` — live xStocks + Backpack mints, `catalog-snapshot.json` fallback; `resolve.ts` picks xStock → Backpack → none; `prices.ts` Jupiter Price v3 |
| Swaps | Individual trades: Jupiter Swap V2 `/order` → sign → `/execute` in `src/lib/jupiter.ts` (live keyless or keyed; stub in dev) |
| Native indexes | `src/lib/index-vaults/adapter-contract.ts`; SDK `1.0.22`, read-only builders, durable local journals, public funds and USDC exits disabled. No second share mint. |
| RPC | Helius URL helper + `@solana/kit` `createSolanaRpc`; browser reaches Helius via `POST /api/rpc` without seeing the key |
| Cache | `src/lib/cache.ts` in-process memo (TTL, stale-while-revalidate); `src/instrumentation.ts` warms the tape at boot |
| Persistence | Supabase saved FMP books + immutable holdings targets + persisted politician profile rankings + copy order contexts/receipts; production copy execution requires service-role storage, never memory fallback |
| Buy gate | `src/lib/allowlist.ts` — `resolveBuyableMint()` against the catalog; no hand list |

API routes:

- `GET /api/health` — boolean adapter flags, derived runtime modes, catalog status and Track A W0 launch readiness; never returns secret values. The [W0 launch checklist](docs/track-a-w0.md#production-launch-checklist-operator) owns readiness interpretation
- `GET /api/people?q=...` — searchable full FMP directory; source pagination/partial status, no featured-person allowlist
- `GET /api/people/[id]/portfolio` — saved stable FMP `senateID` (both chambers), annual document versions, activity, aggregate history, completeness flags and `publishedIndex`
- `GET /api/politician-profiles` — persisted top-20 FMP politician profiles ranked by latest annual holding-band midpoints, with `P000197` Pelosi pinned; disclosed holdings (tradable and not), estimated band values, published weights and completeness flags. `netWorth` / YoY / S&P fields are `null` with reasons until those series exist. Supabase-only; no FMP or AInvest crawl
- `GET /api/published-indexes/[hash]` — immutable published model with persisted constituent target weights; no write or execution endpoint
- `GET /api/disclosures` — insider + congress tape with per-lane provenance in `lanes.{insiders,congress}` (`source`, `live`, `count`, `note`) and `catalog` feed status; every row carries `venue` / `venueSymbol` / `mint` / `mintDecimals` / `tradeEligible`
- `POST /api/rpc` — allowlisted JSON-RPC pass-through to Helius (or public RPC)
- `GET /api/disclosures/[id]` — inspect payload
- `GET /api/signals` · `GET /api/profiles`
- `GET /api/indexes` lists model indexes (crowd first) and explicit unavailable native-position status. Legacy `POST /api/indexes/quote` and `/execute` now return `503` with native release blockers; no fabricated transaction or receipt
- `POST /api/quote` — Jupiter `/order` for at least 1 USDC notional, catalog-enforced (`403` for a mint outside the catalog); a signable order requires a valid wallet and saved server context
- `POST /api/execute` — verify the server-saved quote context, call Jupiter `/execute`, then save a copy receipt; see the [W0 receipt contract](docs/track-a-w0.md#receipt-contract)
- `GET /api/positions/copies?wallet=<Solana public key>` — no-store, wallet-scoped copy receipt history; see the [W0 receipt contract](docs/track-a-w0.md#receipt-contract)
- `GET /api/positions?wallet=<Solana public key>` — confirmed on-chain share balance for the existing devnet test vault only (no-store); missing/invalid wallet returns 400, RPC/identity failures return 503, never an inferred zero. No NAV or fill-derived balances. See `src/lib/index-vaults/devnet-positions.ts`.

UI routes:

- `/` indexes first: published holdings targets, searchable saved people, links to original disclosed books
- `/feed` the raw disclosure tape (Everything / Following, search, buy/sell filter)
- `/p/[id]` disclosed book (every name, status, est. range, venue, copy) + paper trail, 24h/30d/90d disclosed volume ranges
- `/indexes/[id]` model allocation, native lifecycle/fee disclosure and disabled investment panel; no holder rebalance button
- `/disclosures/[id]` inspect
- `/trade/[id]` one-print live Jupiter quote + explicit Privy approval/signature
- `/positions` connected wallet’s saved copy receipts, no invented balances or NAV; existing devnet share diagnostic is separate and opt-in

## FMP person backend

The contract and publication procedure are documented in [`src/lib/fmp/README.md`](src/lib/fmp/README.md). `/api/people`, `/api/people/[id]/portfolio` and `/api/politician-profiles` read Supabase only; they never fetch FMP or write archives. Home, `/p/[stable FMP ID]`, and `/indexes/fmp-[hash]` show saved annual books, activity and published model targets. Existing legacy `/api/profiles`, copy and swap routes remain independent. Do **not** feed FMP activity into the PTR-netted `src/lib/fomo/book.ts` calculator.

Set server-only `FMP_API_KEY`, or use `$HOME/.config/fmp-api-key` for local development. Requests use the `apikey` **header**, never a browser secret or query credential. FMP capture never writes the app disk, so read-only Vercel functions are safe. The [FMP backend contract](src/lib/fmp/README.md#transport-and-completeness) owns redaction, Supabase persistence and failure semantics.

Live integration verification on 2026-09-14 returned **540 real directory entries** after a verified empty page, and **369 PTR activity rows** for `L000397`. These are dated observations, not hard-coded expected provider sizes. The annual endpoint repeated the **same 250 rows** on page 1, ignoring pagination in that probe. The implementation retains the rows and flags `repeated-page` / `partial`; it does **not** advertise a complete annual book or index input. The annual aggregate endpoint is a documented unpaginated yearly series and is fetched once.

Only a complete, unambiguous annual document version can supply `indexInput` (stocks and ETFs, no size/tradability cap). Separate years are never summed; multiple documents for one year remain unreconciled versions. Later PTRs never rewrite that input. Annual names in the live schema have **no dedicated ticker**: apparent symbols inside free-text names are not automatically approved identity mappings. Such rows remain visible and unresolved. Explicit symbols can be mapped by the pure catalog function (xStock then Backpack); options/bonds/income/liabilities cannot become stock exposures just because their symbol matches. A mint tag is availability, **not execution approval**.

A profile does not guarantee an annual book. `npm run holdings:ingest -- --save` ingests missing annual snapshots, including Pelosi (`P000197`), without requesting trades. Failed/partial sources stay labelled. `npm run indexes:publish -- --publish` builds **holdings-based** models from the latest saved annual document, resolving names with archived FMP candidates or that person’s saved symbol evidence. `npm run profiles:publish -- --publish` ranks those saved books into a durable top-20 (`P000197` pinned) without calling FMP or AInvest and without inventing net-worth or performance series. Target weights use holding value-band midpoints, otherwise labelled equal weights, xStock first then Backpack. Unresolved and nontradable names stay on the full book. Trades may supply identity evidence later, never remaining balances. Models are not funded vaults, historical performance or execution-approved baskets. Apply the owner migrations listed in the FMP contract before either publisher; see that contract for dry-run behavior and limitations.

## Devnet vault settlement (Raydium-only prices)

Symmetry vault pricing is **Raydium pools only**: no Pyth oracle type, no Hermes client, no `HERMES_*`/`PYTH_*` environment, nothing paid. `npm run vault:settle:devnet -- --step observe` reads the one existing execution-test vault; the other steps (`deposit`, `lock`, `update-prices`, `mint`, `claim-bounty`) dry-run by default and only sign with the authorized devnet keypair under `--execute`. A full deposit → lock → Raydium `update_prices` → mint → claim roundtrip is recorded in [`evidence/vaults/DEVNET_TEST_VAULT.md`](evidence/vaults/DEVNET_TEST_VAULT.md); procedure and caveats in [docs/devnet-vault-settle.md](docs/devnet-vault-settle.md). This is an operator tool; it does not enable app deposits or change public investment gates.

## Devnet vault redemption diagnostic

`npm run vault:redeem:preflight -- --shares-raw 1` inspects the existing execution-test vault only. It fails closed with no signing/broadcast, no new vault and no USDC conversion. See [native redemption procedure and dated readback](docs/devnet-vault-redeem.md). This does not enable app withdrawals or change public investment gates.

## Buy catalog

**Buy only if the output mint is in the Solana catalog.** The catalog is read live (keyless, memoised hourly) from the two issuers whose tokens Jupiter can route, and falls back to the committed snapshot when an issuer is unreachable:

| Issuer | Source | Tokens | Venue tag |
| --- | --- | --- | --- |
| xStocks (Backed) | `https://xstocks.com/us/products` → `__NEXT_DATA__.products[].addresses.solana` | ~715 Solana mints (~650 US-listed) | `xstock` · `NVDAx` |
| Backpack tokenised stocks | `https://api.backpack.exchange/api/v1/assets` → `.US` assets with a Solana `contractAddress` | ~1,139 mints | `backpack` · `NVDA.US` |

When both issuers list a name the **xStock mint wins**, then Backpack. Backpack's `/markets` and `/securities` (brokerage symbols) are not a buy list. A thin Backpack pool is a quote-time miss: the holding still shows, the copy fails honestly.

Refresh the offline snapshot with `npm run catalog:snapshot` (writes `src/lib/venues/catalog-snapshot.json`; never edit by hand). Quote mint: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

`POST /api/quote` returns `403` for a requested mint outside the catalog. Execution re-resolves the mint from the server-saved quote context and returns `403` if it is no longer catalog-listed. `GET /api/health.catalog` reports whether each issuer served live or from the snapshot.

## Compliance

InsiderIndex is **not available to persons in the United States, United Kingdom, Canada, or Australia**. The eligibility banner is rendered on every page. The trade ticket requires explicit self-attestation before signing. This is UX-only, not server-enforced geo or identity verification.

xStocks and Backpack `.US` tokens are tokenized stock exposures, not listed equity. Individual trades and native investor actions require user authorization. Future native fund rebalances use eligible keeper tasks, not holder signatures; unattended execution remains disabled.

## Local run

```bash
npm install
cp .env.example .env.local
```

Fill the keys in `.env.local` for the live path you want to test, then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

- **Insiders are live from SEC EDGAR with no key.** The first crawl after boot takes ~30 s (paced to the SEC's 10 req/s rule); it is warmed at startup and refreshed every 10 min in the background.
- **Congress is live** when `AINVEST_API_KEY` is set. Without it: labelled `mock-congress` fixtures in development, an empty lane in production. AInvest only answers per ticker, so the lane crawls `AINVEST_UNIVERSE` (`wide` ≈ 300 hand-kept names · `catalog` (default) adds every US-looking xStock underlying · `full` adds every Backpack `.US` token), `AINVEST_PAGES_PER_TICKER` deep, memoised per ticker for `AINVEST_TICKER_TTL_MINUTES`. The crawl stops early on rate limits and says so in `lanes.congress.note`.
- **The buy catalog is live** from xstocks.com and api.backpack.exchange with no key; the committed snapshot covers outages.
- **Jupiter** quotes live (keyless) in production or when `JUPITER_API_KEY` / `JUPITER_MODE=live` is set; stub in development. **Helius** is used when `HELIUS_API_KEY` is set.
- **Privy** is the real `@privy-io/react-auth` Solana provider when `NEXT_PUBLIC_PRIVY_APP_ID` is set. Missing configuration or a failed SDK load never enables a production stub: the wallet stays unavailable and offers a reload. Every trade requires an explicit signature. A fixture wallet exists only in a non-production `NEXT_PUBLIC_INSIDERINDEX_PREVIEW=1` UI preview, where writes are disabled.

Without keys, saved-data surfaces report unavailable data rather than inventing books. Development disclosure adapters may still serve labelled fixtures, but a real wallet is required outside the explicit UI preview.

### Live product workspace

Home shows saved FMP people and published holdings targets. Search covers the entire returned directory before the display limit; the show-more controls expose the remaining rows. Profiles use provider portraits and show the full annual book before separate published model targets. `/positions` is scoped to the connected wallet; opening the wallet address menu offers copy, positions and disconnect without logging out on a normal click.

W0 trading is **one catalog-listed stock token per user-signed swap**, not basket ownership. Home/person/index CTAs are research-only with a primary link to `/feed`; devnet investment previews are not promoted on these surfaces. Native vault APIs remain unchanged and fail closed. Legacy basket quote/execute remain `503`. See [W0 launch checklist](docs/track-a-w0.md), [native integration status](src/lib/index-vaults/README.md) and [UI direction](docs/ui-design.md).

```bash
npm run build
```

must succeed with the example env (no real secrets in the repo).

```bash
npm test        # parser, saved-data, and semantic React-render / wallet-fallback suites
npm run typecheck
```

## Environment

Copy `.env.example` → `.env.local`. Do not commit `.env`, `.env.local`, or `.env*.local`. See `.env.example` for empty placeholders:

- `SEC_EDGAR_USER_AGENT` — contact string sent to SEC EDGAR (sane default); `EDGAR_FILINGS_PER_TICKER`, `EDGAR_DISABLED`, `EDGAR_UNIVERSE=wide`, `EDGAR_TICKERS`
- `FMP_API_KEY` — server-only FMP person directory, annual books and activity; local fallback `$HOME/.config/fmp-api-key`
- `AINVEST_API_KEY` — AInvest Congressional Trades (primary legacy congress tape source); crawl width `AINVEST_UNIVERSE=wide|catalog|full`, `AINVEST_TICKERS`, depth `AINVEST_PAGES_PER_TICKER`, `AINVEST_PAGE_SIZE`, `AINVEST_CONCURRENCY`, `AINVEST_TICKER_TTL_MINUTES`
- `XSTOCKS_CATALOG_DISABLED` / `BACKPACK_CATALOG_DISABLED` — `1` drops an issuer from the buy catalog
- `FORM4API_KEY` — Form4API fallback (insiders + House PTRs)
- `STOCKLANA_ALLOW_MOCKS` — `1`/`0` to force labelled fixtures on/off in development; always off in production
- `JUPITER_MODE` — `live`/`stub` development override; always live in production
- `NEXT_PUBLIC_PRIVY_APP_ID` — Privy wallet (`NEXT_PUBLIC_PRIVY_APPID` alias also accepted)
- `PRIVY_APP_ID` / `PRIVY_APP_SECRET` — Privy server SDK
- `HELIUS_API_KEY` — builds `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` (public Solana RPC when empty)
- `JUPITER_API_KEY` — live Jupiter Swap V2 `/order` → `/execute`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — required with the Supabase URL for production quote contexts and copy receipts; apply `202609150001_copy_positions.sql`, then `202609150002_prune_copy_orders.sql`, before deploying

Do not commit real keys. Live vs fixture:

| Adapter | On | Off |
| --- | --- | --- |
| Insiders | SEC EDGAR (`edgar-form4`, always) → Form4API (`form4`, `FORM4API_KEY`) | `mock-form4` in dev only; empty lane in prod |
| Person-first Congress | FMP (`FMP_API_KEY` or local key file) | explicit unavailable/partial response; never fixtures |
| Congress tape | AInvest (`ainvest-congress`, `AINVEST_API_KEY`) → Form4API (`congress`, `FORM4API_KEY`) | `mock-congress` in dev only; empty lane in prod |
| Jupiter `/order` + `/execute` | Live Swap V2 (prod default, or `JUPITER_API_KEY` / `JUPITER_MODE=live`) | stub quote/fill (dev default) |
| Helius RPC | `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` (server + `/api/rpc` proxy) | public Solana RPC |
| Privy | Real `@privy-io/react-auth` Solana provider (`NEXT_PUBLIC_PRIVY_APP_ID`) | unavailable in production; fixture only in explicit local UI preview |

Every row carries its `source` label. In live Jupiter mode a failed quote is an error, never a stub fill. Privy never auto-signs.

Congress rows are STOCK Act PTRs: they disclose a dollar range (`amountLow`/`amountHigh`, parsed from AInvest's `$15K–$50K` bands), not a share count or price, so `sharesAmount`/`pricePerShare` are `null` and render as `—` — never `$0`. Disclosed volume and book value are shown as ranges (sum of bands). AInvest rows carry no bioguide id or chamber; profiles are keyed by name slug (`pol-nancy-pelosi`).

## Deploy

**Production:** [https://insiderindex.xyz](https://insiderindex.xyz).

| Where | How |
| --- | --- |
| Local | `cp .env.example .env.local`, fill keys, `npm run dev` |
| Production | Configure the deployment environment, build, and route `insiderindex.xyz` to the resulting service |
| Health | Check `/api/health` using the [W0 launch checklist](docs/track-a-w0.md#production-launch-checklist-operator) |
| Congress | Set `AINVEST_API_KEY` or the congress lane stays empty in production (no invented politicians) |

`NEXT_PUBLIC_*` values (including `NEXT_PUBLIC_PRIVY_APP_ID`) must be present at image **build** time so the client bundle can initialize Privy. Rebuild after changing them.

```bash
# Barely Stable Traefik network (default in docker-compose.yml):
# TRAEFIK_NETWORK=edge
# TRAEFIK_CERTRESOLVER=letsencrypt
./scripts/deploy.sh
```

rsyncs the tree to `/srv/projects/stocklana` and excludes `.env`, `.env.*`, `.env.local`, `.env*.local`, `node_modules`, and `.next`. Create or edit secrets only on the box. This Hetzner host is a demo/internal deployment, not the canonical production URL. The image build never `COPY`s `.env*` — `NEXT_PUBLIC_*` is injected only as Docker build args.

**Privy dashboard:** allow `https://insiderindex.xyz`, `https://stocklana.barelystable.dev`, and `http://localhost:3000` as appropriate in allowed origins. Without the matching origin, the live wallet client will not finish loading. Do not commit real keys.
