# Stocklana V1

Disclosure-to-trade scaffold for the Solana Stocklana hackathon.

**Form 4 / Congress disclosure → full disclosed book per filer → copy one print or buy that person's index → user-signed swap into the name's Solana mint (xStock, else Backpack token) → rebalance on the next filing.**

This repository is a Next.js App Router app. **Demo / production host:** [https://stocklana.barelystable.dev](https://stocklana.barelystable.dev) (Barely Stable on Hetzner + Traefik). Do not use a Vercel URL as the public demo. SEC EDGAR needs no key and is always live; AInvest, Form4API, Privy, Jupiter, Helius, and Supabase sit behind env keys so `npm run build` works without secrets.

## Product scope

In V1:

- **SEC EDGAR** is the primary Form 4 source (ticker → CIK → recent `4` filings → XML → open-market P/S). No key.
- **AInvest Congressional Trades** is the primary House/Senate source (`AINVEST_API_KEY`, free tier)
- Form4API is a fallback only (`FORM4API_KEY`); labelled mocks only where `STOCKLANA_ALLOW_MOCKS` permits (dev default)
- Home is **indexes first**: crowd baskets and person indexes, shown only when enough real filings back them (`src/lib/fomo/index-readiness.ts`); the raw tape is `/feed`
- Every filer gets a **Pelosi-Tracker-style disclosed book** on `/p/[id]`: every ticker on their PTRs / Form 4s (`src/lib/fomo/book.ts`), sized from the reported bands as a range, tradable or not. The "too thin" gate applies only to **Buy this index**; a profile renders with one holding
- Fallback when a basket is too thin: follow the filer and copy one trade (same name, user-signed swap into its Solana mint)
- Buys (and copy-sells) are allowed only against a mint in the **live Solana catalog** — xStocks + Backpack tokenised stocks (see [Buy catalog](#buy-catalog)); names without a mint stay visible in the book but are not copy-eligible
- One-trade copy **or** a person index (Pelosi Index, Huang Index) that rebalances on the next disclosure
- Performance is never invented: return / hit rate stay `—` until a real dated-trade price series exists
- The user signs every swap and every rebalance. There are no vaults and no unattended trading
- Social frontend: lime editorial discover, party-tinted profiles, person-index tickets, light/dark theme (`src/app` pages + `src/components` + `src/lib/frontend`)

Out of V1:

- Quiver, FMP, EODHD, Bloomberg (paid or too small to be a primary source)
- Ondo Global Markets as a third venue (its mint list needs a key we do not hold; Jupiter search caps at 20 — we do not invent mints)
- Superstate Opening Bell (KYC-allowlisted wallets), PreStocks (pre-IPO SPVs), Forge / Nasdaq Private
- Meteora / Symmetry / a custom on-chain program

## Architecture

```
EDGAR Form 4 + AInvest PTRs  →  book per filer (venue-tagged via the Solana catalog)
                             →  inspect filing / pick basket  →  USDC amount  →  Jupiter /order
                                                                              user signs in Privy
                                                                              Jupiter /execute
                                                                              position store
```

| Layer | Implementation |
| --- | --- |
| App | Next.js App Router, TypeScript, Tailwind CSS v4, shadcn/ui |
| Auth / wallet | Real `@privy-io/react-auth` Solana when `NEXT_PUBLIC_PRIVY_APP_ID` is set; stub wallet otherwise |
| Insiders | `src/lib/disclosures/edgar.ts` (+ pure `edgar-parse.ts`) primary; `form4.ts` orchestrates EDGAR → Form4API → mock. Issuer set: `edgarUniverse()` (`EDGAR_UNIVERSE=wide`, `EDGAR_TICKERS`) |
| Congress | `src/lib/disclosures/ainvest.ts` (+ pure `ainvest-parse.ts`) primary; `congress.ts` orchestrates AInvest → Form4API → mock. AInvest is ticker-scoped (no per-member pull), so the crawl walks `buildCongressUniverse()` (`src/lib/disclosures/universe.ts`) and groups rows by filer |
| Book | `src/lib/fomo/book.ts` (pure): running net of PTR bands per ticker, Form 4 shares-after × price; `insights.ts` tags venue + copy eligibility |
| Buy catalog | `src/lib/venues/solana-catalog.ts` — live xStocks + Backpack mints, `catalog-snapshot.json` fallback; `resolve.ts` picks xStock → Backpack → none; `prices.ts` Jupiter Price v3 |
| Swaps | Jupiter Swap V2 `/order` → sign → `/execute` in `src/lib/jupiter.ts` (live keyless or keyed; stub in dev) |
| RPC | Helius URL helper + `@solana/kit` `createSolanaRpc`; browser reaches Helius via `POST /api/rpc` without seeing the key |
| Cache | `src/lib/cache.ts` in-process memo (TTL, stale-while-revalidate); `src/instrumentation.ts` warms the tape at boot |
| Persistence | Supabase client stub; in-memory positions when keys are absent |
| Buy gate | `src/lib/allowlist.ts` — `resolveBuyableMint()` against the catalog; no hand list |

API routes:

- `GET /api/health` — boolean adapter flags (`edgar` / `ainvest` / `form4` / `jupiter` / `helius` / `privy` / `supabase`) plus derived `modes` (which path each lane takes) and `catalog` (mint / ticker counts, per-issuer `live` vs `snapshot`); never echoes secret values
- `GET /api/disclosures` — insider + congress tape with per-lane provenance in `lanes.{insiders,congress}` (`source`, `live`, `count`, `note`) and `catalog` feed status; every row carries `venue` / `venueSymbol` / `mint` / `mintDecimals` / `tradeEligible`
- `POST /api/rpc` — allowlisted JSON-RPC pass-through to Helius (or public RPC)
- `GET /api/disclosures/[id]` — inspect payload
- `GET /api/signals` · `GET /api/profiles` · `GET /api/follows`
- `GET /api/indexes` · `POST /api/indexes/quote` · `POST /api/indexes/execute` (basket + rebalance). Crowd indexes (`idx-crowd-*`, built in `src/lib/fomo/crowd-indexes.ts`) lead the list; person indexes follow
- `POST /api/quote` — Jupiter `/order`, catalog-enforced (`403` for a mint outside the catalog)
- `POST /api/execute` — Jupiter `/execute`, then record a position
- `GET /api/positions` — tracked user-signed fills

UI routes:

- `/` indexes first: ready baskets, honest "not an index yet" states, follow & copy fallback, latest filings
- `/feed` the raw disclosure tape (Everything / Following, search, buy/sell filter)
- `/p/[id]` disclosed book (every name, status, est. range, venue, copy) + paper trail, 24h/30d/90d disclosed volume ranges
- `/indexes/[id]` person index ticket + rebalance
- `/disclosures/[id]` inspect
- `/trade/[id]` one-print copy + approve/sign stub
- `/positions` tracked book

## Buy catalog

**Buy only if the output mint is in the Solana catalog.** The catalog is read live (keyless, memoised hourly) from the two issuers whose tokens Jupiter can route, and falls back to the committed snapshot when an issuer is unreachable:

| Issuer | Source | Tokens | Venue tag |
| --- | --- | --- | --- |
| xStocks (Backed) | `https://xstocks.com/us/products` → `__NEXT_DATA__.products[].addresses.solana` | ~715 Solana mints (~650 US-listed) | `xstock` · `NVDAx` |
| Backpack tokenised stocks | `https://api.backpack.exchange/api/v1/assets` → `.US` assets with a Solana `contractAddress` | ~1,139 mints | `backpack` · `NVDA.US` |

When both issuers list a name the **xStock mint wins**, then Backpack. Backpack's `/markets` and `/securities` (brokerage symbols) are not a buy list. A thin Backpack pool is a quote-time miss: the holding still shows, the copy fails honestly.

Refresh the offline snapshot with `npm run catalog:snapshot` (writes `src/lib/venues/catalog-snapshot.json`; never edit by hand). Quote mint: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

`POST /api/quote` and `POST /api/execute` return `403` when the output mint is not in the catalog. `GET /api/health.catalog` reports whether each issuer served live or from the snapshot.

## Compliance

Stocklana is **not available to persons in the United States, United Kingdom, Canada, or Australia**. The eligibility banner is rendered on every page. The trade ticket also requires an explicit self-attestation before the stub signature is accepted.

xStocks and Backpack `.US` tokens are tokenized stock exposures, not listed equity. V1 never places a trade without a user signature.

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
- **Privy** is the real `@privy-io/react-auth` Solana provider when `NEXT_PUBLIC_PRIVY_APP_ID` is set; stub wallet only if that id is missing. Every trade still requires an explicit user signature. A live Jupiter order can never be "signed" by the stub wallet.

Without API keys in development the copy flow stays fixtures-only:

1. The feed loads real EDGAR Form 4 prints plus mock congress rows (labelled)
2. Inspect a filing
3. Enter a USDC amount and request a Jupiter stub order
4. Connect the Privy stub wallet, attest eligibility, approve & sign
5. The fill appears on `/positions`

```bash
npm run build
```

must succeed with the example env (no real secrets in the repo).

```bash
npm test        # node --test parser suites (EDGAR Form 4 XML, AInvest envelope/size ranges, catalog parsers, book reconstruction, universe)
npm run typecheck
```

## Environment

Copy `.env.example` → `.env.local`. Do not commit `.env`, `.env.local`, or `.env*.local`. See `.env.example` for empty placeholders:

- `SEC_EDGAR_USER_AGENT` — contact string sent to SEC EDGAR (sane default); `EDGAR_FILINGS_PER_TICKER`, `EDGAR_DISABLED`, `EDGAR_UNIVERSE=wide`, `EDGAR_TICKERS`
- `AINVEST_API_KEY` — AInvest Congressional Trades (primary congress source); crawl width `AINVEST_UNIVERSE=wide|catalog|full`, `AINVEST_TICKERS`, depth `AINVEST_PAGES_PER_TICKER`, `AINVEST_PAGE_SIZE`, `AINVEST_CONCURRENCY`, `AINVEST_TICKER_TTL_MINUTES`
- `XSTOCKS_CATALOG_DISABLED` / `BACKPACK_CATALOG_DISABLED` — `1` drops an issuer from the buy catalog
- `FORM4API_KEY` — Form4API fallback (insiders + House PTRs)
- `STOCKLANA_ALLOW_MOCKS` — `1`/`0` to force labelled fixtures on/off (default: dev on, prod off)
- `JUPITER_MODE` — `live`/`stub` override
- `NEXT_PUBLIC_PRIVY_APP_ID` — Privy wallet (`NEXT_PUBLIC_PRIVY_APPID` alias also accepted)
- `PRIVY_APP_ID` / `PRIVY_APP_SECRET` — Privy server SDK
- `HELIUS_API_KEY` — builds `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` (public Solana RPC when empty)
- `JUPITER_API_KEY` — live Jupiter Swap V2 `/order` → `/execute`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Do not commit real keys. Live vs fixture:

| Adapter | On | Off |
| --- | --- | --- |
| Insiders | SEC EDGAR (`edgar-form4`, always) → Form4API (`form4`, `FORM4API_KEY`) | `mock-form4` in dev only; empty lane in prod |
| Congress | AInvest (`ainvest-congress`, `AINVEST_API_KEY`) → Form4API (`congress`, `FORM4API_KEY`) | `mock-congress` in dev only; empty lane in prod |
| Jupiter `/order` + `/execute` | Live Swap V2 (prod default, or `JUPITER_API_KEY` / `JUPITER_MODE=live`) | stub quote/fill (dev default) |
| Helius RPC | `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` (server + `/api/rpc` proxy) | public Solana RPC |
| Privy | Real `@privy-io/react-auth` Solana provider (`NEXT_PUBLIC_PRIVY_APP_ID`) | stub wallet |

Every row carries its `source` label. In live Jupiter mode a failed quote is an error, never a stub fill. Privy never auto-signs.

Congress rows are STOCK Act PTRs: they disclose a dollar range (`amountLow`/`amountHigh`, parsed from AInvest's `$15K–$50K` bands), not a share count or price, so `sharesAmount`/`pricePerShare` are `null` and render as `—` — never `$0`. Disclosed volume and book value are shown as ranges (sum of bands). AInvest rows carry no bioguide id or chamber; profiles are keyed by name slug (`pol-nancy-pelosi`).

## Deploy

**Public host:** [https://stocklana.barelystable.dev](https://stocklana.barelystable.dev)

| Where | How |
| --- | --- |
| Local | `cp .env.example .env.local`, fill keys, `npm run dev` |
| Server | gitignored `.env` at `/srv/projects/stocklana` — the deploy script never rsyncs `.env` / `.env.local` |
| Traefik | Compose router rule is locked in `docker-compose.yml`. Barely Stable’s network is `edge` (default). Override with `TRAEFIK_NETWORK=edge` if you need to set it explicitly; do not switch the host. |
| Health | `GET https://stocklana.barelystable.dev/api/health` reports which adapters are configured (`true`/`false`) and the derived `modes` |
| Congress | Set `AINVEST_API_KEY` in the server `.env` or the congress lane stays empty in production (no invented politicians) |

```
Host(`stocklana.barelystable.dev`)
```

```bash
# Barely Stable Traefik network (default in docker-compose.yml):
# TRAEFIK_NETWORK=edge
# TRAEFIK_CERTRESOLVER=letsencrypt
./scripts/deploy.sh
```

rsyncs the tree to `/srv/projects/stocklana` and excludes `.env`, `.env.*`, `.env.local`, `.env*.local`, `node_modules`, and `.next`. Create or edit secrets only on the box. Wildcard DNS already points at the Barely Stable / Hetzner host. The image build never `COPY`s `.env*` — `NEXT_PUBLIC_*` is injected only as Docker build args.

`NEXT_PUBLIC_*` values (including `NEXT_PUBLIC_PRIVY_APP_ID`) must be present in the server `.env` at image **build** time so the client bundle is live, not stub.

**Privy dashboard:** allow `https://stocklana.barelystable.dev` (and `http://localhost:3000` for local) in allowed origins. Without that origin, the live wallet client will not finish loading. Do not commit real keys.
