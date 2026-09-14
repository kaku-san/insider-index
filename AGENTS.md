<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stocklana

Disclosure-to-copy-trade app: real insider/politician prints → user-signed xStock swaps on Solana. Product scope, env matrix, and API routes live in `README.md`; empty env template in `.env.example`.

## Commands

- `npm run dev` / `npm run build` / `npm run typecheck`
- `npm test` — `node --test` suites in `tests/*.test.mts`; they import pure parser modules directly, so keep `*-parse.ts` files free of `@/` aliases, env, and fetch.
- `npm run lint` has pre-existing `react-hooks` errors in `src/components/*`; do not treat a red lint as caused by data-layer work.

## Data sources (authoritative: `src/lib/disclosures/`)

- Insiders: SEC EDGAR primary (`edgar.ts`, no key, paced ≤10 req/s, `SEC_EDGAR_USER_AGENT`), Form4API fallback, mocks dev-only. Orchestration and `source` labelling in `form4.ts`.
- Congress: AInvest primary (`ainvest.ts`, `AINVEST_API_KEY`), Form4API fallback, mocks dev-only. AInvest rows have no ticker/bioguide/chamber in the payload; envelope errors are HTTP 200 with non-zero `status_code`.
- `STOCKLANA_ALLOW_MOCKS` (default dev on / prod off) is the only switch that lets fixture rows into a lane. `GET /api/disclosures` → `lanes` tells you what actually served.

## Sharp edges

- Next bundles route handlers, SSR, and `instrumentation.ts` as separate module graphs; anything that must be shared per-process (caches, rate pacers) goes through `globalState()` in `src/lib/cache.ts`, never a bare module-level variable.
- The EDGAR cold crawl takes ~30 s; `src/instrumentation.ts` warms it at boot and `memo()` serves stale-while-revalidate afterwards. Verify with two timed `curl /api/disclosures`.
- `next start` ignores `output: "standalone"`; test prod with `node .next/standalone/server.js`. The server process renames itself to `next-server`, so `pkill -f server.js` misses it — kill by port.
- Jupiter Swap V2 works keyless; `jupiterMode()` in `src/lib/runtime.ts` decides live vs stub. In live mode a stub-wallet signature or stub requestId is rejected by `/api/execute` on purpose.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
