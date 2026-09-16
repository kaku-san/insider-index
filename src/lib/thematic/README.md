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

`RESEARCH_MODEL` — Basket Buy / vault deposit unavailable (W0). Views also carry
`fundable: false`; the directory + each view expose `status`/`fundable`/`sourceGeneratedAt`
so the UI can prove a research model is not a fundable person vault index.

## Profile page + fundable-vs-research distinction

- `/indexes/idx-theme-<slug>` (`src/components/thematic-index.tsx`) is a person-quality
  research profile: linked member roster (`/p/<bioguideId>`), constituents with weight + venue,
  source + as-of date, and an unmistakable non-fundable state (disabled deposit CTA, research
  banner) exactly where a person index would offer investing.
- Home shelf (`consumer-home.tsx` `#themes`) and the directory tag each theme card
  `Research · not investable`; person indexes keep the `PERSON INDEX` badge. A fundable person
  vault index and a research thematic index must never read as the same product.

## Ten no-position-book politicians

`src/lib/frontend/no-index-people.ts` lists the ten politicians with no mappable book
(six no-holdings-book, four trades-only) whose person pages stay live with an honest
`No InsiderIndex person index` note (`fmp-portfolio.tsx`) pointing to the thematic desk —
never a dead end or a half-built person index. The ten thematic research indexes fill the
index lineup in their place. This is a frontend reference only; it drives no mapping/vault/db.

Tests: `tests/thematic-profile.test.mts`.
