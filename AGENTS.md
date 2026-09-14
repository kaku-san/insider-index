<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stocklana

Disclosure-to-copy-trade app: real insider/politician prints → user-signed xStock swaps on Solana. Product scope, env matrix, and API routes live in `README.md`; empty env template in `.env.example`.

- Product shape: **indexes first, feed second, follow & copy one trade as the fallback.** Home (`/`) is `src/components/index-home.tsx`; the raw disclosure tape is `/feed`. Do not reintroduce party/executive lanes as top-level navigation.
- Every filer's **full disclosed book** (every ticker, tradable or not) is `src/lib/fomo/book.ts` → `/p/[id]`. Readiness (`src/lib/fomo/index-readiness.ts`) gates only "Buy this index"; never filter a book by tradability. Crowd indexes are `src/lib/fomo/crowd-indexes.ts`.
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
- Jupiter live vs stub is `jupiterMode()` in `src/lib/runtime.ts`; live mode rejects stub signatures.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
