# Stocklana V1

Disclosure-to-trade scaffold for the Solana Stocklana hackathon.

**Form 4 / Congress disclosure → FOMO profile → copy one print or buy that person's index → user-signed xStock basket on Solana → rebalance on the next filing.**

This repository is a Next.js App Router app. **Demo / production host:** [https://stocklana.barelystable.dev](https://stocklana.barelystable.dev) (Barely Stable on Hetzner + Traefik). Do not use a Vercel URL as the public demo. Live Form4API, Privy, Jupiter, Helius, and Supabase clients are stubbed behind env keys so `npm run build` works without secrets.

## Product scope

In V1:

- Form4API is the primary disclosure source (mock Form 4 + House PTRs when `FORM4API_KEY` is unset)
- Congress is a first-class lane: Democrats / Republicans, politician profiles, and person indexes
- Buys (and copy-sells) are allowed only against the verified xStock mint allowlist
- One-trade copy **or** a person index (Pelosi Index, Huang Index) that rebalances on the next disclosure
- The user signs every swap and every rebalance. There are no vaults and no unattended trading

Out of V1:

- Congress trading (adapter file exists, not wired)
- Quiver
- Meteora / Symmetry / a custom on-chain program

## Architecture

```
Form 4 feed  →  inspect filing  →  USDC amount  →  Jupiter /order
                                                  user signs in Privy
                                                  Jupiter /execute
                                                  position store
```

| Layer | Implementation |
| --- | --- |
| App | Next.js App Router, TypeScript, Tailwind CSS v4, shadcn/ui |
| Auth / wallet | Real `@privy-io/react-auth` Solana when `NEXT_PUBLIC_PRIVY_APP_ID` is set; stub wallet otherwise |
| Disclosures | `src/lib/disclosures/form4.ts` adapter + mock allowlisted Form 4s |
| Congress | `src/lib/disclosures/congress.ts` empty stub, skipped |
| Swaps | Jupiter Swap V2 `/order` → sign → `/execute` in `src/lib/jupiter.ts` |
| RPC | Helius URL helper + `@solana/kit` `createSolanaRpc` |
| Persistence | Supabase client stub; in-memory positions when keys are absent |
| Allowlist | `src/lib/allowlist.ts` |

API routes:

- `GET /api/disclosures` — Form4 + Congress tape
- `GET /api/disclosures/[id]` — inspect payload
- `GET /api/signals` · `GET /api/profiles` · `GET /api/follows`
- `GET /api/indexes` · `POST /api/indexes/quote` · `POST /api/indexes/execute` (basket + rebalance)
- `POST /api/quote` — Jupiter `/order` stub, allowlist-enforced
- `POST /api/execute` — Jupiter `/execute` stub, then record a position
- `GET /api/positions` — tracked user-signed fills

UI routes:

- `/` discover (live tape, executives, D/R, indexes)
- `/p/[id]` FOMO profile with portrait, portfolio chart, 24h/30d/90d
- `/indexes/[id]` person index ticket + rebalance
- `/disclosures/[id]` inspect
- `/trade/[id]` one-print copy + approve/sign stub
- `/positions` tracked book

## Allowlist rule

**Buy only if the output mint is on the verified xStock list in `src/lib/allowlist.ts`.**

| Underlying | xStock | Mint |
| --- | --- | --- |
| NVDA | NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` |
| AAPL | AAPLx | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` |
| TSLA | TSLAx | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` |
| MSFT | MSFTx | `XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX` |
| META | METAx | `Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu` |
| AMZN | AMZNx | `Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg` |
| GOOGL / GOOG | GOOGLx | `XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN` |
| SPY | SPYx | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` |
| QQQ | QQQx | `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ` |
| NFLX | NFLXx | `XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL` |
| COIN | COINx | `Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu` |
| MSTR | MSTRx | `XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ` |

Quote mint: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`  
xStocks mint authority note: `S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS`

`POST /api/quote` and `POST /api/execute` return `403` when the output mint is not on that list.

## Compliance

Stocklana is **not available to persons in the United States, United Kingdom, Canada, or Australia**. The eligibility banner is rendered on every page. The trade ticket also requires an explicit self-attestation before the stub signature is accepted.

xStocks are tokenized stock exposures, not listed equity. V1 never places a trade without a user signature.

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

- **Form4 is live** when `FORM4API_KEY` is set (mock Form 4 + House PTRs when empty)
- **Jupiter + Helius** power live quotes when `JUPITER_API_KEY` and `HELIUS_API_KEY` are set
- **Privy** is the real `@privy-io/react-auth` Solana provider when `NEXT_PUBLIC_PRIVY_APP_ID` is set; stub wallet only if that id is missing. Every trade still requires an explicit user signature.

Without API keys the app stays fixtures-only:

1. The feed loads mock Form 4 buys for allowlisted tickers
2. Inspect a filing
3. Enter a USDC amount and request a Jupiter stub order
4. Connect the Privy stub wallet, attest eligibility, approve & sign
5. The fill appears on `/positions`

```bash
npm run build
```

must succeed with the example env (no real secrets in the repo).

## Environment

Copy `.env.example` → `.env.local`. Do not commit `.env`, `.env.local`, or `.env*.local`. See `.env.example` for empty placeholders:

- `FORM4API_KEY` — live Form4 + Congress tape when set
- `NEXT_PUBLIC_PRIVY_APP_ID` — Privy wallet (`NEXT_PUBLIC_PRIVY_APPID` alias also accepted)
- `PRIVY_APP_ID` / `PRIVY_APP_SECRET` — Privy server SDK
- `HELIUS_API_KEY` — builds `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` (public Solana RPC when empty)
- `JUPITER_API_KEY` — live Jupiter Swap V2 `/order` → `/execute`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Do not commit real keys. Live vs fixture:

| Adapter | On (key set) | Off (key missing) |
| --- | --- | --- |
| Form4 / Congress | Live Form4API (`FORM4API_KEY`) | mock-form4 + mock House PTRs |
| Jupiter `/order` + `/execute` | Live Swap V2 (`JUPITER_API_KEY`) | stub quote/fill |
| Helius RPC | `https://mainnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>` | public Solana RPC |
| Privy | Real `@privy-io/react-auth` Solana provider (`NEXT_PUBLIC_PRIVY_APP_ID`) | stub wallet |

Form4 / Jupiter fall back to mock/stub if the live provider errors. Privy never auto-signs.

## Deploy

**Public host:** [https://stocklana.barelystable.dev](https://stocklana.barelystable.dev)

| Where | How |
| --- | --- |
| Local | `cp .env.example .env.local`, fill keys, `npm run dev` |
| Server | gitignored `.env` at `/srv/projects/stocklana` — the deploy script never rsyncs `.env` / `.env.local` |
| Traefik | Compose router rule is locked in `docker-compose.yml` |

```
Host(`stocklana.barelystable.dev`)
```

```bash
./scripts/deploy.sh
```

rsyncs the tree to `/srv/projects/stocklana` and excludes `.env`, `.env.local`, `.env*.local`, `node_modules`, and `.next`. Create or edit secrets only on the box. Wildcard DNS already points at the Barely Stable / Hetzner host.

`NEXT_PUBLIC_*` values (including `NEXT_PUBLIC_PRIVY_APP_ID`) must be present in the server `.env` at image **build** time so the client bundle is live, not stub.

Allow `https://stocklana.barelystable.dev` in the Privy dashboard allowed origins. Do not commit real keys.
