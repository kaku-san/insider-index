# Trade-index publication verification — 2026-09-14

Published with `npm run indexes:publish -- --publish` after the owner applied migrations `202609140002` and `202609140003`. No FMP fetch, annual-row edits, wallet transactions, or fund broadcasts were performed.

## Persisted Supabase results

- 14 `index_versions`, 316 `constituents` (previously both zero).
- All 14 published targets have at least one Solana mint and exactly 10,000 total weight bps.
- All 14 people have partial annual books. Publication correctly used their saved trade symbols independently of annual pagination.
- Both catalog feeds were live. All published targets used the labelled `trade-band-midpoints` methodology (gross disclosed buys and sales, not remaining holdings).

| Person ID | Saved name | Constituents |
| --- | --- | ---: |
| A000383 | Alan Armstrong | 62 |
| B001291 | Brian Babin | 6 |
| B000668 | Cliff Bentz | 2 |
| B001288 | Cory Anthony Booker | 8 |
| B001292 | Donald Sternoff Beyer | 40 |
| B001257 | Gus Bilirakis | 5 |
| A000148 | Jake Auchincloss | 1 |
| B001299 | James E. Banks | 5 |
| B001236 | John Boozman | 112 |
| A000379 | Mark Alford | 5 |
| B001277 | Richard Blumenthal | 8 |
| A000372 | Rick W. Allen | 58 |
| A000055 | Robert Aderholt | 3 |
| B000740 | Stephanie I. Bice | 1 |

## Book preservation

Complete paginated `select('*')` reads, ordered by primary key, matched the pre-publication SHA-256 of `JSON.stringify(rows)` exactly:

| Table | Rows | Before = after SHA-256 |
| --- | ---: | --- |
| people (including saved portfolios) | 540 | `bd2c3c72e9c2e0b5cf264fba6a674e1a7cd79269b2bb9278392ae4995ff5b84c` |
| disclosed_items | 5719 | `fd5c33ea188ac465872f856d19a7f7b6abcb7759caf0e5cb00b9b435d72809c4` |
| transactions | 2423 | `0a5a8eaae3173d89f3cfead348843b3c42c70ce8018c42139eb271c21d2c25e7` |

## Application validation

- `npm test`: 67 passing, zero failures.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run lint`: not clean (9 errors, 6 warnings): existing React hook/compiler findings in untouched frontend components, plus two `no-explicit-any` errors and one unused-import warning in the gitignored local RPC verification script. Full lint remains for the no-mistakes gate; no clean-lint claim.
- Local **production build**, connected to the real Supabase store: HTTP 200 for `/api/people`, all 14 published-person portfolio endpoints, one immutable published-index endpoint, `/`, a person page, and its index page.
- Directory response asserted `storage: supabase`, 540 people and 14 published links. Every tested portfolio asserted partial annual coverage, nonempty persisted constituents and 10,000 bps. Server-rendered HTML included target links, full annual-book section, target weights and persisted mint evidence.
- Example target: `/indexes/fmp-692f13f9ff9f499e943bf9f1fd0433e1b8436a7026ba632192586056034fff61`; original book: `/p/A000383`.

The database publication is live. These HTTP checks establish the branch's production-build behavior, **not a deployed Vercel rollout**. Branch delivery and CI remain subject to no-mistakes; no production-site deployment is claimed here. No Chrome was used. The maintained API/publication contract is in `src/lib/fmp/README.md`.
