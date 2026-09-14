# Holdings-first read integration verification

Imported the holdings-first publication/ingestion backend and owner migration from `fm/stocklana-holdings-first-f1`, retaining the current Pelosi Tracker person layout and canonical index names. No live ingestion, publication, migration, or source-row writes were performed during this integration.

## Reproduction and result

The previous `store.ts` reader filtered every published-index query to `disclosed-trade-activity`. Pelosi's existing Supabase `CANDIDATE` has basis `disclosed-holdings`, so the reader returned `publishedIndex: null` despite persisted constituents.

Verified the updated local Next server against the supplied live Supabase environment using HTTP requests, without a browser:

- `/api/people/P000197/portfolio`: 12 annual versions, 250 retained rows total, 65 in the latest 2024 document; zero saved trades; a published holdings target with 15 names totaling 10,000 bps.
- `/api/people?q=Pelosi`, the portfolio endpoint, and `/api/published-indexes/f8da0bc7c9309074e0e335e536ac57b2dabd1dd0b0ec4a1b5fce4ba53384b6c5` agree on the target and `Nancy P Index` name.
- `/p/P000197` server-rendered HTML contains the populated allocation pie and visible NVDA/xStock and AXP/Backpack holdings labels, not “No published allocation yet.” Matthews International Mutual Fund remains listed and disclosed-only. Source ranges and annual rows remain unchanged; target weights stay separate.

This verifies the new code with live data locally, **not a Vercel deployment**. The application must be deployed before the production page uses this reader.

## Checks

- `npm test`: 91 passing, including actual owner-RPC execution in PGlite and HTTP-to-render regression coverage.
- `npm run typecheck` and `npm run build`: passed.
- ESLint for changed code: passed.
- Full `npm run lint`: existing React hook errors in untouched `index-ticket.tsx`, `trade-approve.tsx`, and `providers/ui-provider.tsx`; existing warnings in `feed-view.tsx` and `person-avatar.tsx`. These remain for the no-mistakes validation phase rather than broadening the integration change.
