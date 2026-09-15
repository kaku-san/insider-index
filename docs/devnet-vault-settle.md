# Existing devnet vault: Raydium-only settlement

`npm run vault:settle:devnet` drives the native deposit lifecycle of the **one existing devnet test vault** (`Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8`, share mint `Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A`) with **Raydium prices only**. It never creates a vault, never installs a Pyth oracle, never opens a Hermes client, and refuses to start if any `HERMES_*` or `PYTH_*` variable is set. It is an operator tool for the authorized devnet wallet, not an app route: `publicFundsEnabled` and every UI gate stay unchanged.

## Policy encoded in code

- [`src/lib/index-vaults/raydium-oracles.ts`](../src/lib/index-vaults/raydium-oracles.ts): `oracle_type` must be `raydium_clmm` or `raydium_cpmm` (`assertRaydiumOnlyToken`, wired into `NativeVaultBuilders.addToken`); installed native oracles must all be Raydium (`assertRaydiumOnlyVault`); `mint → pool + kind` bindings only (`DEVNET_RAYDIUM_POOLS`, `raydiumPoolFor` blocks unknown mints instead of inventing a pool); `planRaydiumPriceUpdate` builds the native `update_token_prices` instruction from the vault's own lookup-table oracle accounts. The pinned SDK's `updateTokenPricesTx` is not used anywhere because it unconditionally instantiates a Hermes client even with zero Pyth oracles; `NativeVaultBuilders.settle("prices")` now routes through the Raydium planner.
- `tests/raydium-oracles.test.mts` fails CI if `@pythnetwork`, `HermesClient`, Hermes/Pyth env reads, or the SDK's Hermes-backed builders appear under `src/lib/index-vaults` or `scripts`.
- Program logs are checked on every simulation and receipt: a priced token whose log line reports oracle `type: 0` (Pyth) fails the step closed.

## Commands

```sh
npm run vault:settle:devnet -- --step observe
npm run vault:settle:devnet -- --step <claim-bounty|update-prices|mint> --intent <PUBKEY> [--execute]
npm run vault:settle:devnet -- --step deposit --usdc-raw 100000 [--execute]
npm run vault:settle:devnet -- --step lock [--execute]
```

- Default is **dry-run**: build, decode and `simulateTransaction` only; no signer is loaded and the RPC wrapper rejects `sendTransaction`.
- `--execute` loads `~/.config/stocklana-devnet-keypair.json` (or `--keypair PATH`), checks it is the authorized wallet `C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB`, simulates each transaction immediately before sending with a fresh blockhash, waits for finalization, and stops once `--max-sol-debit` (default `0.02` SOL) is exceeded. The secret is never printed or written.
- Fixed devnet RPC and genesis; no network, vault, wallet or mainnet flags exist.
- Public receipts (signature, slot, fee, wallet debit, message hash, oracle types from logs) are appended to `evidence/vaults/devnet-raydium-settlement.json`; a private send log goes to `.data/index-vaults/devnet-settle.log`.

## Lifecycle (SDK keeper order)

1. `deposit` = `buyVaultTx` (init intent + contribute). Refuses if the owner already has an intent.
2. `lock` = `lockDepositsTx`; the intent moves to `update_prices`.
3. `update-prices` = Raydium-only native instruction. Refuses when the pool observation is older than the installed staleness threshold.
4. Auctions run for the on-chain window (about 175 s here) — `observe` reports `auction-wait` until they end.
5. `mint` = `mintTx`; shares arrive in the owner's share account.
6. `claim-bounty` = `claimBountyTx`; returns the bounty to the keeper and closes the intent. Also the correct step for a post-mint intent that older attempts tried to cancel or re-price.

Every step re-reads the intent and refuses unless the SDK-derived next action matches.

## Devnet-specific caveats

- The Symmetry instruction layout includes two fixed WSOL/USDC custody reference accounts as program constants. They are not vault oracles and this tool never updates them; on devnet the USDC leg (pool quote side priced in WSOL) therefore reads ~1.23 because the pool's ratio differs from the program's stale WSOL reference. Deposit valuation and vault TVL use the same prices, so the mint ratio stays fair; on mainnet with live pools the leg prices converge to market.
- The pool only records observations on swaps; with no organic devnet volume the price goes stale after the installed 3600 s.
- Devnet oracle thresholds (9999 bps confidence/volatility/slippage, min liquidity 0) are test values. Production listing needs a deep Raydium pool per mint and real thresholds.
- No flash-swap settlement, automated rebalance, redemption, share transfer or fee claim is run by this tool; the vault stays 100% USDC against a 50/50 target until a keeper rebalances.

Authoritative receipts and dated readback: [`evidence/vaults/DEVNET_TEST_VAULT.md`](../evidence/vaults/DEVNET_TEST_VAULT.md) (Raydium-only settlement section).
