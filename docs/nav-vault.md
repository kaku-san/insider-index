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

**Status: devnet NOT run** (faucet rate-limited; decision `devnet-sol` = ship on local proofs). Evidence instead: the LiteSVM suites above, the real-Jupiter CPI test, and a full `solana-test-validator` rehearsal of this script — `evidence/vaults/nav-vault-localnet-rehearsal.json` (localnet signatures, not devnet receipts): deposit 100 → 99.75 shares + 0.25 fee, two keeper buys leaving a 5.50% buffer, 2-share USDC exit (1.999998 USDC), full exit via in-kind fallback (3.486271 USDC + both stocks), every readback equal to the prepare estimate. Devnet receipts would go to `evidence/vaults/nav-vault-devnet.json`.

## Not done here

Audit, mainnet deploy, Raydium direct-pool adapter in the TS keeper (on-chain allowlist supports it; `buildCycleRoute` rejects off-curve owners), async large exits, migrating the Symmetry Mag7 vault.
