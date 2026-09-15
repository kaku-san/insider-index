# Track A W0 — copy one print

Day-1 executable product: `/feed` → one catalog-listed xStock/Backpack print → Jupiter `/order` → explicit Privy wallet signature → Jupiter `/execute` → saved copy receipt. At least $1 USDC notional. Sells debit the stock token and receive USDC; they require an existing token balance. No basket Buy, multi-leg execution, native-vault release, Pyth or Hermes setup is part of W0.

Home and person/index pages are research surfaces. Their trade CTA leads to the separate feed, not an inferred FMP-to-tape identity match. `/api/indexes/quote` and `/api/indexes/execute` remain `503`. Compliance banner and client self-attestation remain UX-only, not server-enforced identity or geography verification.

## Receipt contract

Apply `supabase/migrations/202609150001_copy_positions.sql` to the production Supabase project before deploying. It creates service-role-only, RLS-enabled `copy_orders` and `positions` tables. Do not expose the service role to the browser.

- Signable quotes save their request ID, wallet, catalog metadata, expiry and transaction-message hash. Execution requires that saved context and the identical signed message; client ticker/mint/amount fields cannot manufacture receipts. A disclosure ID is contextual attribution, not proof of FMP identity or portfolio ownership.
- Storage is checked before quoting/submission. Production requires Supabase URL + service role, and never silently falls back to memory. Configured storage failures also fail closed in development.
- Receipts are immutable and idempotent by request ID, with unique transaction signatures. Exact provider fill amounts are stored as atomic-unit strings. Omitted amounts stay null, never quoted amounts or invented zeroes.
- A post-fill storage error returns the successful execution and signature with `persistence: "failed"`. The UI displays the warning instead of claiming a saved position. **Do not repeat the trade.** Retain the signature for operator reconciliation against Jupiter/on-chain evidence; automatic reconciliation is not implemented.
- `/api/positions/copies?wallet=<public key>` returns at most the latest 100 receipts, no-store, scoped to that public address. This is public-address trade history, not authenticated private account data. Database tables themselves are not browser-readable.
- `/positions` shows receipts first, never their sum as current holdings, portfolio value, P&L or NAV. Exit is W1. The existing `/api/positions` devnet share diagnostic is unchanged and displayed only when explicitly opened; it is not a mainnet portfolio.

## Production launch checklist (operator)

Use the current production host in `README.md`. No real keys, keypairs or signed transaction payloads belong in git or this checklist.

1. Apply the migration with the Supabase owner. Do not claim durability until the production tables exist and the service role can read/insert.
2. Configure `NEXT_PUBLIC_PRIVY_APP_ID` at **build time**, mainnet `HELIUS_API_KEY`, `JUPITER_MODE=live` (optional `JUPITER_API_KEY`), server `FMP_API_KEY`, valid/rotated `AINVEST_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and server `SUPABASE_SERVICE_ROLE_KEY`. Allow the production origin in Privy. Production ignores stub/mock/preview overrides; still set `STOCKLANA_ALLOW_MOCKS=0` and remove `NEXT_PUBLIC_STOCKLANA_PREVIEW` to avoid accidental development previews. Never set `PYTH_*` or `HERMES_*`.
3. Redeploy the reviewed commit; rebuild whenever public env changes. `/api/health` must report live Jupiter, Privy, Helius, no mocks, a nonempty catalog and `launch.receipts=true`. `ok`/`copyReady` mean configuration + storage readiness, **not** provider credential verification or proof a trade filled.
4. Check `/api/disclosures` lane provenance: real SEC/AInvest rows, no mock source; rotate invalid AInvest credentials and redeploy if needed. Check `/api/people` reads saved FMP people. A key's presence alone is not evidence it works.
5. Verify `/`, person and index pages say research-only, link to `/feed`, and cannot open a basket investment. POST both legacy basket endpoints and confirm `503`.
6. An eligible participant connects a real Privy wallet, funds at least $1 USDC plus required network costs, opens a catalog-eligible print, attests, reviews the live quote and signs explicitly. Check the successful signature on mainnet and `persistence: "saved"`.
7. Reload `/positions`, reconnect the same wallet, and confirm the receipt remains through a cold deployment/process. Check another address cannot be confused with this wallet. Never infer remaining holdings from receipts.

No browser automation or real-money signing was performed by the implementation tests. Production secret rotation, migration application, redeployment and the authorized-wallet smoke above are separate operational evidence and must be recorded before claiming “live.”

## Local verification

`npm test` includes `tests/copy-w0.test.mts`: the real migration in PGlite/PostgreSQL, service-role/RLS permissions, real Supabase client requests, message binding with a locally signed synthetic transaction, catalog rejection, fill persistence/idempotency, buy/sell units, outage handling and semantic receipt rendering. Jupiter is a deterministic test transport; these are not mainnet fills. Run `npm run typecheck`, `npm run build`, and no-mistakes before publishing the feature branch.
