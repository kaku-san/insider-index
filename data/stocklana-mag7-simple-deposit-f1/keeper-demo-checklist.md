# Mag7 simple-deposit keeper demo checklist

Full commands and ATA mint list: [`../stocklana-b-keeper-setup-f1/keeper-runbook.md`](../stocklana-b-keeper-setup-f1/keeper-runbook.md).

- [ ] From repo root, prepare the external key and mainnet identity:

  ```sh
  export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
  export KEEPER_KEYPAIR=/absolute/path/outside-this-repository/mag7-keeper.json
  export SHARE_MINT=9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4
  ```

- [ ] Run the runbook's read-only ATA inventory, create only its missing canonical ATAs, then rerun it until `missing=0`.
- [ ] Fund the keeper to the runbook's exact `70000000` lamport (0.07 SOL) target. The direct settler itself refuses more than 0.05 SOL keeper debit per invocation.
- [ ] After the user has finalized both app-provided `buyVaultTx` and `lockDepositsTx`, run:

  ```sh
  export USER=<base58-wallet-that-finalized-buyVaultTx-and-lockDepositsTx>
  npm run keeper:mag7-deposit -- --owner "$USER" --dry-run
  npm run keeper:mag7-deposit -- --owner "$USER" --execute --keypair "$KEEPER_KEYPAIR" --watch
  ```

- [ ] Do **not** use `npm run keeper:index` (rebalance-only) or `npm run keeper:cycle` (not this direct-deposit path).
- [ ] After the keeper reports a finalized `mint`, run the runbook's share-supply/user-ATA verification command. It must print `shareSupplyRaw > 0` and `userSharesRaw > 0`.
- [ ] Keep the key outside the app/repository; do not add it to `.env.local`, server code, or a deployed environment.
