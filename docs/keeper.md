# NAV keeper

The keeper is a separate operator process, **not a Vercel function or user wallet**. Entry/exit preparation in the app never loads signing keys. Source: `scripts/nav-vault-cli.mts`, `src/lib/nav-vault/{keeper,mainnet-venue}.ts`.

## One cycle

1. Read each on-chain NAV vault, balances, share supply and withdrawal requests.
2. Quote marks (Raydium first, Jupiter fallback): the **mid** of a $100 ask and the matching bid (sell-side) quote, the bid re-measured every 5 minutes. Multi-vault cycles reuse each mint quote and batch price posts where they fit. With `--loop`, marks post from an independent loop (below), not from this cycle.
3. Cross reserved withdrawal stock against free vault USDC at the mark.
4. Sell remaining withdrawal slices, oldest request first.
5. Rebalance free inventory toward on-chain target weights while respecting the USDC buffer.
6. Settle converted requests; after a request's timeout, deliver slices that still cannot sell in kind, only to their owners.

A failing step never aborts the cycle: later legs, settles and other vaults still run. A swap whose venue quote cannot pass the on-chain posted-price bound is refused before sending; any failed swap is **deferred per leg** with backoff (2 min doubling to 30 min, in-process memory) so the planner tries the next leg instead of retrying forever. A withdrawal-request slice that fails to sell retries on a short backoff (30 s doubling to 2 min) for the whole request timeout, so the keeper keeps trying to pay USDC first. Only after the timeout does a slice that still fails go **in kind, pro-rata, to the owner**, and only into token accounts the owner already has: the keeper never creates or pays rent for owner accounts (an owner could close them and keep the rent). A slice with no owner account stays on the request for the owner's own in-kind claim.

Swaps try **Jupiter v1 quote + swap-instructions first**, restricted to CPI-safe DEXes. If no usable route exists, the builder falls back to a direct persisted Raydium CLMM pool. Jupiter v2 builds are used for marks, not the mainnet swap CPI path. No keeper side-payment funds a user's fill. Each on-chain swap independently enforces venue, inventory, reserve, slippage and authority constraints.

## Configuration

- Node.js 22.18+, installed npm dependencies.
- `HELIUS_API_KEY` or an explicit operator `--rpc` endpoint.
- `JUPITER_API_KEY` for Jupiter routes/marks.
- `NEXT_PUBLIC_SUPABASE_URL` and **server-only** `SUPABASE_SERVICE_ROLE_KEY` for DB definitions and `--all` enumeration. `--definition <file.json>` can supply a single persisted definition instead.
- A dedicated keeper keypair, stored outside this repository. It must match the vault's keeper and must not be its admin. Fund only the SOL needed for network fees; vault inventory pays for swaps.

Historical DB vault addresses do not select NAV custody: the CLI derives the NAV PDA from each index ID and reads the chain state. Persisted definitions supply mint/pool metadata.

## Commands

Default is **dry run**. Do not add `--execute` when inspecting.

```sh
npm run nav-vault -- keeper --index idx-theme-mag7-caucus --network mainnet-beta
npm run nav-vault -- keeper --all --network mainnet-beta
```

Only an authorized operator should broadcast:

```sh
npm run nav-vault -- keeper --all --network mainnet-beta \
  --execute --keypair /secure/path/keeper.json --loop 40
```

RPC use is paced: one request in flight, `--rpc-interval-ms` apart (default 125), with 429 backoff that honours `Retry-After`; confirmations poll signature status, so no websocket is opened. Lookup tables and failing-leg deferrals are cached across `--loop` cycles.

With `--loop`, marks run on an **independent schedule** (`--marks-every`, default 20 s) with their own paced RPC connection: that loop only quotes and posts `update_prices` for every vault, so swaps, settles and in-kind deliveries can never delay a price post past the 60 s `max_price_age`. The trading cycle then trades on the posted on-chain marks and skips a vault whose posted marks are stale. `--marks-every 0` restores marks inside the trading cycle.

`--loop` is a target cycle period in seconds and requires execution. Mainnet vaults have **60-second marks**. Monitor observed price age, errors, request age, failed quotes and keeper SOL; do not assume a requested loop period proves fresh marks. Near or beyond the freshness boundary, deposits must refuse until a new mark lands.

### Pause / resume

```sh
# Simulate first; pause/unpause use the admin, never the keeper.
npm run nav-vault -- pause --index idx-theme-mag7-caucus --network mainnet-beta
# Authorized operator only:
npm run nav-vault -- pause --index idx-theme-mag7-caucus --network mainnet-beta \
  --execute --keypair /secure/path/admin.json
```

Use `unpause` with the same inspection/authorization process. Pause is on chain and leaves request/claim recovery available. App kill switches are distinct and do not pause the program. Never stop an active keeper as a substitute for pausing deposits: stale marks are a refusal condition, not a recovery workflow.

### Creation and slice publication

`init --index <id> --slice --keeper <pubkey> --fee-owner <pubkey>` reads the committed tradable slice; without `--slice` it reads the persisted definition. Pass **`--max-price-age 60`** explicitly for the recorded mainnet policy (the CLI default is 300). Initialization defaults to dry run and refuses more than 16 legs; token-account creation, LUT creation and vault initialization are separate operator transactions. `--lut <address>` can reuse an interrupted lookup table. Do not retry after partial execution without inspecting chain state.

`npm run nav-vault -- slices` prints a dry-run report. **`slices --publish` writes the database**, using the service-role RPC after migration `202609230001`; unlike chain execution, this write is controlled by `--publish`, not `--execute`. Publishing disclosure metadata does not create a vault or change its on-chain legs.

## Incident handling

Inspect transaction errors and current chain balances before retrying. Never manufacture receipt/progress state or pay users from the keeper to conceal failed fills. For stale marks, restore valid price posting; for a price-band refusal, investigate rather than repeatedly nudging the mark. Admin price override and holder-only in-kind refund are explicit privileged recovery tools described in [nav-vault.md](nav-vault.md). No key material, live signing, deployment or keeper lifecycle action is needed for the offline test suite.
