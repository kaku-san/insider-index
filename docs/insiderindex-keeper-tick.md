# InsiderIndex keeper: run one tick by index id

This is the operator runbook for the DB-driven keeper. It reads **everything** —
vault address, share mint, legs, target weight bps, cap, keeper and fee parameters —
from `insiderindex_vault_definitions` for the index id you pass. There is no
`--vault`/`--share-mint` argument and no hardcoded basket, so the four real vaults
(Pelosi, Gottheimer, Mag7 Caucus, Silicon Hill) and any future index all run the
same way.

CLI: `scripts/insiderindex-keeper-tick.mts` · library: `src/lib/index-vaults/keeper-tick.ts`
(drift/eligibility stays in the shared `rebalance-eligibility` module via
`kaku-san-rebalance.ts`; this keeper never adds a second copy or a private threshold).

## What you need first

- The **index id** of a *created* vault. The tick refuses an index whose
  `vault_address`/`share_mint` are still unset (nothing to rebalance yet), an
  unreadable/absent definition, and a row that names a different keeper than your
  keypair.
- Supabase **service-role** credentials in `.env.local` (the command reads it) so
  the tick can read the definition and record the outcome. Without them it fails
  closed.
- For a real tick only: the **dedicated keeper hot-wallet** keypair as a 64-byte
  JSON array file, on the operator machine, **outside the web app tree**. Public
  address for these vaults: `GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq`. The
  tick refuses a keypair inside `src`/`app`/`public`/`.next`, and refuses a keeper
  equal to the vault deployer, host treasury or a strategy/manager wallet. The web
  app never holds this key and there is no environment-variable path for it.

Find the index id you want (for example the Pelosi row) with your usual Supabase
read; the ids are the `index_id` primary key in `insiderindex_vault_definitions`.

## Dry run (the default — broadcasts nothing)

```sh
npm run keeper:index -- --index <indexId>
# identical, explicit:
npm run keeper:index -- --index <indexId> --dry-run
```

A dry run loads **no** keypair and broadcasts **nothing**. It prints, for that
index:

- current on-chain weights vs. target weight bps, with the per-leg drift,
- the eligibility verdict from the shared rule (`YES`/`no`/`unknown` + reason),
- the trades it *would* place (buy underweight, sell overweight; weight-space, real
  amounts settle on-chain),
- and it records `mode:"dry-run"` onto the definition row — a dry run **never**
  records a rebalance.

The human report is printed to stderr; machine JSON to stdout. Read the report and
confirm the drift and intended trades look right before you ever run with
`--execute`.

## Real tick (broadcasts only when eligible)

```sh
npm run keeper:index -- --index <indexId> --execute --keypair /absolute/path/to/keeper-keypair.json
```

Executing requires **both** the explicit `--execute` flag **and** passing the same
shared eligibility rule. A tick that is not eligible does nothing and says so
(`skipped-not-eligible`), recording that outcome without any broadcast. When
eligible it signs with the keeper key and broadcasts (existing rebalance intents
are reconciled first via a Raydium price update; otherwise a normal rebalance),
then records the real outcome (`rebalanced`/`prices-updated`) with the signatures
onto the definition row.

There is no `--force-rebalance`; force is refused. A leg with no tradable pool is
refused rather than traded, and weight is never silently re-weighted around a
missing pool.

## What gets recorded

Every tick writes back onto the index's definition row through the security-definer
RPC `record_insiderindex_vault_rebalance` (migration
`supabase/migrations/202609180001_insiderindex_vault_rebalance_record.sql`):

- `last_rebalance_at` — the time of the tick (dry run or real),
- `last_rebalance_result` — the outcome jsonb; a dry run is `mode:"dry-run"`, a real
  broadcast tick carries `mode:"execute"` plus the step, signatures and slot.

So the site and any later automation read one source of truth, and a dry run is
always distinguishable from a real rebalance.

## Safety notes

- Dry run is the default; you must opt into `--execute`.
- The keeper key is a file path only — never an env var, never in the app tree,
  never the deployer/host/strategy wallet.
- No Pyth/Hermes: prices and eligibility are Raydium-first, Jupiter if no pool
  (see `raydium-oracles.ts` / the index-vaults README).

## Tests

`node --experimental-strip-types --test tests/insiderindex-keeper-tick.test.mts`
covers: dry run broadcasts nothing (and records `dry-run`, never a rebalance),
execute without eligibility does nothing, a wrong keeper is refused, a
deployer/host/strategy keypair is refused (including end-to-end from a real file),
a keypair in the app tree is refused, a missing vault address is refused, and the
recorded result distinguishes a dry run from a real tick.
