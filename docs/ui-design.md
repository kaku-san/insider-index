# Stocklana live UI

## Direction

Everyone is an insider. Public disclosures are the invitation, not privileged information or a promise of performance. The home surface is an index explorer, with people and their original evidence one step away.

- Palette: paper white `#fafbf8`, ink `#253128`, leaf `#52763c`, lime `#d0f568`, muted lilac `#e9e4f5`, line `#dce2d8`. Lime is a small identity accent, not a full-page wash.
- Type: system humanist sans (Avenir Next when available), strong tightly spaced display, readable 14–16px product copy, tabular figures for values. No external font request.
- Layout: left-aligned workspace. A large invitation headline sits alongside a static insider membership pass. Published indexes form a compact shelf; the directory is a searchable ledger, not 540 disconnected cards. Person pages put the full disclosed book before trade-derived targets.
- Personality: the membership pass is the single playful gesture. Evidence stays quiet, legible and explicit about uncertainty. No fake charts, rankings, positions or returns.

```
[existing navigation] [current location / wallet]
                      Everyone is    [Insider pass]
                      an insider.
                      [Copy one print] [Research indexes] [Find a person]
                      Published indexes / model-only notice
                      [name + index] [name + index] [name + index]
                      People / search / chamber filter
                      portrait  name  coverage  open book
```

## Review before build

Rejected a full lime hero with floating politician headshots: it repeats the previous marketing treatment and implies a featured portfolio. Instead the pass belongs to “You”, never Pelosi or a fabricated index. No ornamental rankings, generic fade-up sections, or invented headline numbers. Directory and publication counts come only from the saved API response.

## Interaction and truthfulness

- Keep `/api/people` and saved portfolio contracts unchanged. Client display limits never truncate the underlying directory; search covers every returned person.
- Annual books preserve all source rows and nullable ranges, including unmapped assets. Trade targets are separately labeled and never represented as current holdings.
- Published targets are models, not execution-approved products. Track A W0 disables basket investment controls on home, person and index surfaces and links their trading CTA to `/feed` for a separate one-print copy. Do not connect these models to legacy multi-leg basket execution.
- Motion: 160ms CSS press feedback using Emil Kowalski's `cubic-bezier(0.23, 1, 0.32, 1)`. No animated data, list filtering, keyboard interactions or section entrances. Reduced motion disables movement.
- Use component-scoped `disclosure-workspace.module.css` for home, saved person and published index surfaces. Shared chrome remains in `globals.css`.

## Verification

Run `npm run typecheck`, `npm test`, `npm run lint` and `npm run build`. Exercise search, chamber filtering, empty results, show-more controls, original source links, mobile table scrolling, themes and keyboard focus. Browser visual verification must respect the task's no-Chrome restriction; report when screenshots are not available rather than claiming visual approval.
