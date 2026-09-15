<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stocklana

Disclosure-to-copy-trade app: real insider/politician prints → user-signed xStock swaps on Solana. Product scope, env matrix, and API routes live in `README.md`; empty env template in `.env.example`.

- W0 release: `docs/track-a-w0.md` owns launch checks and receipt semantics. Home (`src/components/index-home.tsx`) remains indexes-first research; primary trading CTA is `/feed` → copy one print. Basket Buy stays unavailable. Copy receipts are not balances/NAV; production requires service-role Supabase. Do not reintroduce party/executive lanes as top-level navigation.
- FMP holdings-first books/indexes: `src/lib/fmp/README.md` → Supabase-only people/portfolio reads. `holdings-index.ts` builds from the latest saved annual snapshot; `holding-resolution.ts` retains identity evidence separately. Trades are optional, never balances. Owner publication is `supabase/migrations/202609140004_holdings_indexes.sql`; never rewrite annual rows or route FMP through the legacy PTR-netted calculator.
- Person portfolios: `src/components/fmp-portfolio.tsx` renders saved annual rows independently of publication; `src/lib/fmp/index-name.ts` owns canonical index/vault names. `src/components/profile-view.tsx` keeps legacy insider books (`src/lib/fomo/book.ts`) visible and resolves Congress IDs to FMP. Never filter a disclosed book by tradability. Legacy basket readiness is `src/lib/fomo/index-readiness.ts`; crowd indexes are `src/lib/fomo/crowd-indexes.ts`.
- Native indexes: `src/lib/index-vaults/README.md` owns integration/release status; `adapter-contract.ts` is the app boundary. One Symmetry V3 vault/native share mint per index; no receipt wrapper or purchase-row ownership. Vault funding/signing fails closed pending native readiness and explicit budget authorization. Legacy index quote/execute are retired; individual copy trades remain separate.
- **Symmetry prices are Raydium-only.** `src/lib/index-vaults/raydium-oracles.ts` rejects `oracle_type: "pyth"`, maps `mint → Raydium pool` (never invent one), and builds `update_token_prices` without the SDK's `updateTokenPricesTx` (it always opens a Hermes client). Never add Hermes/Pyth clients, keys or `HERMES_*`/`PYTH_*` env; `tests/raydium-oracles.test.mts` fails CI on them. Devnet settlement on the one existing test vault: `npm run vault:settle:devnet` (`docs/devnet-vault-settle.md`); receipts in `evidence/vaults/DEVNET_TEST_VAULT.md`.
- **Buy catalog, not an allowlist.** Copyable ⇔ the ticker has a Solana mint in `src/lib/venues/solana-catalog.ts` (live xStocks + Backpack `.US`, xStock preferred; snapshot fallback via `npm run catalog:snapshot`). Ondo/Superstate/PreStocks are excluded on purpose (README "Out of V1"). Never hand-add a mint.
- PTRs are dollar bands: keep `amountLow`/`amountHigh` nullable, render ranges, never `$0`. Return / hit rate stay null until a real price series exists.

## Commands

- `npm run dev` / `npm run build` / `npm run typecheck`
- `npm test` — `tests/*.test.mts`; keep `*-parse.ts` free of `@/` aliases, env, and fetch.

## Data sources (`src/lib/disclosures/`)

- Insiders: SEC EDGAR primary (`edgar.ts`), Form4API fallback, mocks dev-only.
- Congress: AInvest primary (`ainvest.ts`, `AINVEST_API_KEY`), Form4API fallback, mocks dev-only. AInvest is ticker-scoped (no per-member pull): the crawl universe is `buildCongressUniverse()` in `universe.ts` (`AINVEST_UNIVERSE`).
- `GET /api/disclosures` → `lanes` tells you what actually served; `catalog` says whether venue tags came from the live catalog or the snapshot.

## Sharp edges

- Shared caches go through `globalState()` in `src/lib/cache.ts`.
- EDGAR cold crawl ~30 s; warmed at boot via `src/instrumentation.ts`.
- Jupiter live vs stub is `jupiterMode()` in `src/lib/runtime.ts`; live mode rejects stub signatures. Wallet fallback (`src/components/providers/privy-provider.tsx`) fails closed in production; a Privy load failure must never enable a fixture wallet.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
