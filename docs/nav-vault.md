# NAV vault (ERC-4626-style, one signature each way) — branch prototype

Unaudited hackathon program. Devnet only. Flag-gated; the live Symmetry Mag7 rail is untouched.

## Shape

| Action | Signer | What happens in that one transaction |
| --- | --- | --- |
| `deposit(usdc, min_shares)` | user | 0.25% entry fee → fee account; net USDC → vault; shares mint at NAV |
| `withdraw(shares, min_usdc)` | user | burn; USDC from the buffer if it covers the NAV value, else the exact pro-rata slice of every vault account (stocks + USDC) |
| `withdraw_in_kind(shares)` | user | price-free pro-rata exit (works with stale marks) |
| `update_prices(prices)` | keeper | marks + timestamp/slot |
| `keeper_swap(in, out, amount_in, min_out, data)` | keeper | vault PDA signs one venue swap via CPI |

- NAV = USDC buffer + Σ(leg balance × keeper mark). Never the tutorial's `total_assets = USDC balance`.
- Shares: `net × (supply + 1e6) / (NAV + 1e6)` (virtual offset; first deposit is 1:1). Exit value uses the same offset.
- Marks: posted by the keeper (Raydium pool quote first, Jupiter if no pool — `src/lib/nav-vault/mainnet-venue.ts`; devnet reads the mock venue pool). Deposits/priced exits refuse marks older than `max_price_age_secs`; deposits also refuse marks from the current slot and refuse the keeper as depositor.
- `keeper_swap` venue allowlist is compile-time: Jupiter V6 exact-in routes (`route`, `shared_accounts_route`, `route_v2`, `shared_accounts_route_v2`), Raydium CLMM `swap_v2`; the mock venue only in `--features devnet`. After the CPI the program re-reads every vault token account: only the declared input may decrease (≤ `amount_in`), output must rise ≥ `min_out`, value out ≥ value in × (1 − `max_slippage_bps`) at posted marks, share supply unchanged, no delegate/close authority/owner change, and a USDC→leg buy may not leave USDC below `buffer_bps` of NAV (captain: 5%).
- Share mint authority is a separate PDA that never signs a swap CPI.
- Keeper (`src/lib/nav-vault/keeper.ts`): buys toward DB weights down to the buffer (+0.5% margin), sells the most overweight leg when the buffer is short, one swap per transaction, dry run unless `execute` is supplied. The keeper wallet never pays for fills.
- Limits: 16 legs (in-kind exit needs 3 accounts per leg; the vault LUT keeps a 7-leg exit in one v0 packet).

## Code

- Program: `programs/nav-vault` (Anchor 0.31), test/devnet venue `programs/mock-swap`. Committed binaries + hashes: `programs/bin/` (rebuild: `scripts/nav-vault-build.sh`, agave 3.0 `cargo-build-sbf --tools-version v1.52`).
- Client: `src/lib/nav-vault/{program,prepare,keeper,config,server}.ts`; routes `/api/nav-vault/[id]` (readiness), `/position`, `/deposit/prepare`, `/withdraw/prepare` — each prepare returns exactly one transaction.
- Flag: server `STOCKLANA_NAV_VAULT_INDEXES` (+ `STOCKLANA_NAV_VAULT_RPC_URL`, `STOCKLANA_NAV_VAULT_PROGRAM_ID`; network must be devnet); client `NEXT_PUBLIC_NAV_VAULT_INDEXES` routes `VaultFlow` to the NAV endpoints. Off = unchanged Symmetry path.
- Tests: `tests/nav-vault.test.mts` (LiteSVM), `tests/nav-vault-api.test.mts`, `tests/nav-vault-jupiter.test.mts` (mainnet build → captured deployed Jupiter V6 + Raydium CLMM TSLA route with the vault PDA as taker).

## Devnet proof

```
solana program deploy programs/bin/nav_vault_devnet.so --program-id <nav_vault keypair> --url devnet
solana program deploy programs/bin/mock_swap.so --program-id <mock_swap keypair> --url devnet
node --experimental-strip-types scripts/nav-vault-devnet.mts --payer <devnet keypair>
```

`--localnet` rehearses the same script against `solana-test-validator`.

**Devnet proof (done, finalized).** Programs deployed with the upgrade authority `6t6tFss…RkC9`, funded with 3.6 devnet SOL from the devnet test wallet `C7ye…YQyB`; 1.27 SOL was returned afterwards. The programs are left open. Closing is permanent, so the ~2.19 SOL of rent can be recovered later with `solana program close`, as recorded in the evidence. The deployed `nav_vault` bytes match `programs/bin/nav_vault_devnet.so` (sha256 `3fa7cc51…`). Index `idx-nav-devnet-mag7-proof` uses synthetic test mints: tUSDC, a classic 6dp stock stand-in and a Token-2022 8dp stock stand-in. Full receipts are in `evidence/vaults/nav-vault-devnet.json`.

| Step | Signature |
| --- | --- |
| deploy nav_vault | `329wya2aiLSstQPC6C7bCkXZNM1Xp1Mtf86joDgHDYsy6dr3x6mCpfqbBuTvDKtjdi5AwP5vxC6QKH5wHdHKcqpD` |
| deploy mock_swap | `5q5hS4RjKARRTvh1C74q4ZgSa8tsR37ihBjtn5YfwrjphFFSfv5HhXfyh76j5JDY7BAXFk87fRMWTakNcuAnqewZ` |
| init_vault (60/40, 25 bps fee, 5% buffer) | `62gUk8AhvfbsNT5Q95t9v41tEecwStZbdpx55NCAsYXaneANLG1FFsNzcwzwzviKNAxFDhPCWsPmGWX1wCZP6sYL` |
| keeper marks | `221i9PtpTccaZQ1ijy2YudWESfBqBvrL8GmxDNJdFRDMgg4bwJYSSD2iEDe2TaDaTgKdKBT4nMcA4AUS7YCpFnge` |
| ONE-signature deposit 100 → 99.75 shares, 0.25 fee | `43ULRsXmSFeMV4QfzBMkmetfaYL44TYN385jxC21czY5n7bZPZFGtpgzmYK25RbUjvegeYBDeV157Er5Dwbc5Maf` |
| keeper buy stock A (from vault USDC) | `4sEgPkPrXAZVE3cHumLqvJzraeQvyiTyuKrkXReSkDdAxaSFyRSwqy2jFCCk71qSudNhomdFL2LqEyMCzKxpxLVX` |
| keeper buy stock B → buffer 5.50% | `2yEusBeFANDvPccYF8mosR2fgW3CmhhgbDSPStyvrk7Do8CJEP63TokZJYNvG4GPGkMbMfw7ZfHRs1MVCsw6ep7w` |
| ONE-signature USDC exit (2 shares → 1.999998) | `5cEQqHFxe11oo4AFS2dsyeGr3DfdZxknbqpmAoLn2QWZ7NwTS5pnmpRnFjW98M42NzS8mNFgk3wrSoqqxPQQxuZF` |
| ONE-signature full exit, buffer short, in-kind (3.486271 USDC + 282791 A + 9426370 B) | `3jX9Bqv3s4AviiPfwZc7srfyXiD2uBgy9NS77wL9R2y6y3V31LHcJY6u73Xcq5SWddwuRwXHHfYwGY9rmuh3sj1r` |

Every readback matched the prepare estimate, and the keeper wallet's USDC did not change. Keeper swaps on devnet go through the mock venue because Jupiter has no devnet deployment. The Jupiter CPI path is proven offline against the deployed Jupiter binary in `tests/nav-vault-jupiter.test.mts`. The same script's `solana-test-validator` rehearsal is in `evidence/vaults/nav-vault-localnet-rehearsal.json`.

## Not done here

Audit, mainnet deploy, Raydium direct-pool adapter in the TS keeper (on-chain allowlist supports it; `buildCycleRoute` rejects off-curve owners), async large exits, migrating the Symmetry Mag7 vault.
