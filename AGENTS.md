<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# InsiderIndex

Public brand: **InsiderIndex** / **InsiderIndex.xyz**. Package: `insider-index`. Existing `STOCKLANA_*` environment keys and database/API contracts remain compatible.

## Start here

- `README.md`: judge demo, repository map, local run and deployment links.
- `docs/architecture.md`: app, data, program and keeper boundaries.
- `docs/nav-vault.md`: authoritative public rail, safety, deployed-vs-committed binary distinction.
- `docs/keeper.md`: operator commands and key custody.
- `docs/data-sources.md`: full books, source provenance and tradable-slice disclosure.

## Guardrails

- NAV is the only public invest/cash-out/positions rail. Never restore retired vault SDK/create/cycle paths. `src/lib/index-vaults/` now contains shared research definitions, pool evidence and venue utilities, not an alternate vault engine.
- Preserve fail-closed transaction validation in `src/lib/frontend/vault-api.ts` and `src/components/vault-flow.tsx`. Only observed signatures/positions advance settlement; no invented balances, progress percentages or delivery receipts. Production wallet fallback never enables a fixture wallet.
- Live/readiness comes from the on-chain NAV vault, not historical DB vault columns. Preserve server/client kill switches, 60-second mainnet freshness refusal, complete disclosed books and asterisked tradable-slice exclusions. No guessed token mint, pool or NAV.
- The keeper/admin key stays on the operator machine, never the web server. No live signing, deploy, pause, upgrade or keeper lifecycle action is part of validation. NAV marks use Raydium/Jupiter, never Pyth/Hermes.
- Rust edits require `bash scripts/nav-vault-build.sh` and matching committed `programs/bin/` hashes. The current mainnet binary is newer than deployed bytes: see `docs/nav-vault.md`; do not silently upgrade.
- FMP is holdings-first and Supabase-only for public people/portfolio reads (`src/lib/fmp/README.md`). Source buckets/manifests stay verbatim. Trades are information, never balances; nullable dollar bands stay ranges, never `$0`. Catalog identity: xStock preferred, verified Backpack `.US` fallback, never hand-added mints.
- Keep migration history ordered and append-only; retired tables do not authorize execution. Do not rewrite production data to clean up source presentation.
- Shared caches use `globalState()` in `src/lib/cache.ts`; pure `*-parse.ts` modules have no `@/` aliases, environment or fetch.

## Validation

```sh
npm run typecheck && npm test
npm run lint
npm run build
```

Offline/code-level only. **Never launch a browser, headless Chrome/Chromium, dev-server screenshots or DOM dumps.** Browser-dependent scenarios are untested-with-reason. The no-mistakes Test gate is pinned to typecheck + tests in `.no-mistakes.yaml`.

After route removal, stale `.next/types/validator.ts` can reference deleted files: remove the gitignored `.next` cache or rebuild, then rerun typecheck. Keep secrets, local keys and validation reports out of commits; the redacted publication scan is in `evidence/security/secret-scan.json`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
