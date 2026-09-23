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

**Devnet proof on the exact current build (done, finalized).** The devnet program was upgraded in place to `programs/bin/nav_vault_devnet.so` (sha256 `64801cd0…`). A dump of the deployed program matches the committed binary. This is the same source as the mainnet `nav_vault.so`, which only drops the mock venue. The index `idx-nav-devnet-mag7-pilot` ran with the mainnet pilot params: 25 bps entry fee, 5% buffer, 60 s max mark age, $50 per-deposit cap. SOL for the upgrade came from the devnet test wallet, and 1.67 SOL was returned. Receipts are in `evidence/vaults/nav-vault-devnet.json`. The earlier pre-cap run is `evidence/vaults/nav-vault-devnet-precap.json`.

| Step | Signature / result |
| --- | --- |
| upgrade nav_vault (current build) | `4up17akbsvxCPM4acytVyzYQXDBbUK4qTYgNBPXJQfEfrgLtvSZSMoGZsZ6SmGxQK3VhfehfmFZV9qoP7gCtEp3e` |
| init_vault (pilot params) | `3mANY3EoM2n4pSCRGd5V6dnJZoHNHiM6VKdvYwuTTEYHQKvbs2mG6FZ4knCi32fq7nbW6NRZD92Zg4dk4jgf47Xq` |
| 50.000001 tUSDC deposit (simulated) | refused on chain with `DepositAboveCap` |
| ONE-signature deposit of 50 → 49.875 shares, 0.125 fee | `4jpjneu25b1ErL8HmMiLDugzcCUHBVaEnRLZTiu6oQRz8LR8HvvbWhUtXxUX4ggnZxed6sdoiahwLwbqojhDrcnA` |
| keeper buys A / B, buffer ends at 5.50% | `P5Kdsf4XiC6ByYGsMJ9eeVudsqReYtHwsfCdcTCjrv316Jy7C7qCZR8A5nAcTWREEXtgsFFs5ijQB93feBWL2MF` / `S4G71aXg4QudWQz2ZwePzYa1t55Ha8woJoe4VRx1G6HPDc9EmDt2WTDTFmMBKMedWpnxXPmr9eeEvcuyLLLfgWz` |
| ONE-signature USDC exit (2 shares → 1.999995) | `JSUZLwY7Txh1YHghUwQTZArRxV7MyHrKRaYorAtfygiZSVtCWC4h3DwX3Q9rjgMZrzRoKfSqnoDURS6pHcHQ9bz` |
| ONE-signature full exit, buffer short, in-kind (0.743178 USDC + 141395 A + 4713175 B) | `5uxEjdFymqHa1dCuhpZ4YEpDcjZt5Wpkf4qXj1SPC4yk4QMDjNpDeCSqBhoAUBEyP4cSLpzKUXA5JyGV4WiKcXSm` |

Every readback matched the prepare estimate, and the keeper wallet's USDC did not change. On devnet the keeper trades on the mock venue, because Jupiter has no devnet deployment. The Jupiter paths are covered by the offline CPI test against the deployed Jupiter binary and by the read-only mainnet v2 build check in `evidence/vaults/nav-vault-jupiter-v2-readonly.json`.

## Mainnet (captain-approved pilot)

- Build: `programs/bin/nav_vault.so`. The default features pin the venues to Jupiter V6 exact-in routes and Raydium CLMM `swap_v2`; there is no mock venue.
- Cost: program rent is about 1.73 SOL for 340,085 bytes of program data, recoverable with `solana program close`. Init is about 0.05 SOL (vault, share mint, 9 token accounts, LUT). The keeper needs about 0.05 SOL for fees.
- Operator CLI: `npm run nav-vault -- init|keeper …` (`scripts/nav-vault-cli.mts`). It is dry run by default, `--execute --keypair <file>` sends, and the keeper must not be the admin. Pilot flags are `--max-price-age 60 --entry-fee 25 --buffer 500 --max-deposit-raw 50000000`.
- Swaps: Jupiter v2 `/swap/v2/build` is used when `JUPITER_API_KEY` is set, with v1 `/swap-instructions` as the fallback. Both were checked read-only on mainnet with the Mag7 vault PDA as taker. v2 returns `route_v2` and v1 returns `shared_accounts_route`; in both, the PDA is the only signer. Wrapped in `keeper_swap` with the vault LUT, the v2 transactions were 570–801 bytes and 29–48 accounts (see `evidence/vaults/nav-vault-jupiter-v2-readonly.json`). The keeper skips any route that does not fit one packet or 64 accounts.
- App flag: `STOCKLANA_NAV_VAULT_NETWORK=mainnet-beta` (RPC defaults to the server Helius URL) plus the index lists. The public site stays unflipped until the captain decides.

## Not done here

Audit, mainnet deploy, Raydium direct-pool adapter in the TS keeper (on-chain allowlist supports it; `buildCycleRoute` rejects off-curve owners), async large exits, migrating the Symmetry Mag7 vault.
