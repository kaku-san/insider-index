# Mag7 direct-deposit keeper

`scripts/mag7-settle-deposit.mts` is the external laptop-only settlement path for a
**finalized** direct Mag7 `buyVaultTx` + `lockDepositsTx` user intent. It uses the
persisted Mag7 definition, Raydium-only price/fill builders, and the SDK mint/claim
builders. It does not use the public cycle journal, does not load a key in the app,
and `keeper:index` remains rebalance-only.

```sh
npm run keeper:mag7-deposit -- --owner <locked-user-wallet> --dry-run
npm run keeper:mag7-deposit -- --owner <locked-user-wallet> \
  --execute --keypair /absolute/path/outside-the-repository/keeper.json --watch
```

The execute command requires service-role Supabase settings in `.env.local`, an
absolute external 64-byte keeper key that matches the persisted designated keeper,
and all nine canonical keeper ATAs (seven Mag7 stock legs plus WSOL/USDC support).
It refuses missing ATAs, wrong identities, Pyth/Hermes, non-Raydium configuration,
and incomplete books. A direct invocation is bounded to 0.05 SOL of observed keeper
debit; it may be re-run only for the same owner/intent after an inspected wait or
bound stop.

Captain copy/paste setup, exact ATA commands, 0.07 SOL demo target, and native share
supply/user-position verification live in
[`data/stocklana-b-keeper-setup-f1/keeper-runbook.md`](../data/stocklana-b-keeper-setup-f1/keeper-runbook.md).
