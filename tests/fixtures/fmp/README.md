# Recorded FMP stable responses

Captured with the purchased account on 2026-09-14 using an `apikey` request header. The key and request headers are never recorded. Each JSON file contains endpoint, key-free params, fetchedAt and provider payload; these are genuine public congressional disclosures, not fake Pelosi holdings or production fallback data.

- `senate-profile`: first directory page (`limit=2`); profiles cover both chambers despite the endpoint name.
- `senate-profile-person`: actual ID lookup for Zoe Lofgren (`L000397`).
- `senate-net-worth` and `senate-net-worth-page1`: full observed 250-row responses for the same person, requested at `limit=250`. The second page is **identical**. This is a recorded pagination failure, not a complete annual source fixture. Regression tests assert partial ingestion and no index input.
- `senate-net-worth-aggregated`: actual unpaginated yearly category estimates.
- `house-trades-by-id`: first two actual Lofgren rows, including a spouse-owned corporate bond whose symbol must not be treated as a stock holding.
- `senate-trades-by-id`: first two actual Thomas Hawley Tuberville (`T000278`) rows.
- `house-latest`, `senate-latest`: first actual rows; House latest can omit `senateID` and is not silently name-matched.

Tests explicitly **simulate** verified empty pages and synthetic amendments/options/duplicate rows to exercise normalization and failure behavior. Those synthetic scenarios are not represented as live completeness evidence and are never imported by runtime code. A full live directory smoke test returned 540 people through an empty seventh page, and a full Lofgren activity backfill returned 369 records; these dated counts are documented observations, not test constants or universe limits.
