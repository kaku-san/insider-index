# Thematic indexes — live feed

Committed snapshot of 10 multi-member InsiderIndex research themes.
**Not person clones** (Pelosi/MTG stay on `/p/[id]`).

## Feed it

| Surface | Path |
|---|---|
| Static JSON (CMS / external) | `/thematic-indexes.json` (`public/`) |
| App source of truth | `src/lib/thematic/thematic-indexes.live.json` |
| Directory API | `GET /api/thematic-indexes` |
| Detail API | `GET /api/thematic-indexes/:id` |
| Pages | `/indexes/idx-theme-<slug>` |
| Home shelf | consumer `#themes` · legacy index-home `#thematic` |

## Index IDs

`idx-theme-mag7-caucus` · `silicon-hill` · `capitol-cluster` · `bipartisan-handshake` · `fresh-ink` · `beta-caucus` · `whips-desk` · `capitol-arsenal` · `dual-lock` · `house-heat`

## Weight contract

- UI / `PersonIndex`: `weightPct` as **fraction 0–1** (sum ≈ 1)
- Research views: `weight_bps` integers summing to **exactly 10000**
- Every leg has `mint` + `venue` (`xstock` \| `backpack`)

## Status

`RESEARCH_MODEL` — Basket Buy / vault deposit unavailable (W0).
