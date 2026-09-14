<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stocklana project notes

- Product shape: **indexes first, feed second, follow & copy one trade as the fallback.** Home (`/`) is `src/components/index-home.tsx`; the raw disclosure tape is `/feed` (`src/components/feed-view.tsx`). Do not reintroduce party/executive lanes as top-level navigation.
- When something counts as an "index" is defined in one place: `src/lib/fomo/index-readiness.ts` (thresholds + plain-English `need` text). UI gates buying on it; keep server and client using the same module.
- Crowd indexes (`idx-crowd-*`, e.g. Capitol Buys) are built in `src/lib/fomo/crowd-indexes.ts` and reuse the `PersonIndex` shape so `/api/indexes/*` works unchanged; they have no profile page (`profile` is null).
- UI consumes `/api/disclosures` and `/api/indexes`. Disclosure sourcing lives in `src/lib/disclosures/**` — change data there, not in components.
- Empty/thin states must stay honest: never pad with fake filers or synthetic filings outside `NEXT_PUBLIC_STOCKLANA_PREVIEW=1` fixtures (`src/lib/frontend/preview-data.ts`).
- `npm run lint` has pre-existing React-compiler errors in `trade-approve`, `index-ticket`, `portfolio-charts`, `positions-table`, `ui-provider`; compare against `main` before treating lint as a regression. `npm run typecheck` and `npm run build` are clean.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
