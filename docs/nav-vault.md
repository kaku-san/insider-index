# NAV vault (ERC-4626-style, one signature each way) — branch prototype

Unaudited hackathon program. Devnet only. Flag-gated; the live Symmetry Mag7 rail is untouched.

## Shape

| Action | Signer | What happens |
| --- | --- | --- |
| `deposit(usdc, min_shares)` | user (1 sig) | 0.25% entry fee → fee account; net USDC → vault; Token-2022 shares mint at NAV |
| `withdraw(shares, min_usdc)` | user (1 sig) | instant USDC from the **free** buffer when it covers the value (else `UsdcBufferShort`) |
| `request_withdraw(shares, min_usdc, nonce, in_kind_now)` | user (1 sig) | burns the shares and carves the exact pro-rata slice of free USDC and every free leg into a request PDA. The carved amounts are **reserved**: excluded from NAV and from keeper trading, so other holders are unaffected |
| `cross_request_leg(leg)` | keeper | nets a request's leg slice against free vault USDC at the posted mark: the slice returns to the free pool and the request is credited the value. No venue involved |
| `fulfill_swap(...)` | keeper | sells a request's leg slice via Jupiter/Raydium; proceeds are credited to the request (reserved USDC) |
| `settle_request` | keeper or owner | all legs converted and total ≥ `min_usdc` → pays USDC to the owner and closes the request |
| `claim_in_kind(legs)` | owner (after the 10 min timeout, or at once for in-kind/paused/stale requests); keeper/admin anytime | delivers the listed leg slices plus any USDC owed, **only to the owner**. At most 13 legs per transaction; closes the request when it is empty |
| `admin_redeem_in_kind(shares, nonce)` | admin | burns a holder's shares through the Token-2022 permanent delegate (the mint-authority PDA) into an in-kind request payable only to that holder |
| `update_prices(prices)` / `admin_set_prices` | keeper / admin | marks plus a balance-cache refresh. The keeper's marks may not move more than 15% per update; the admin can override |
| `keeper_swap(...)` | keeper | rebalances free inventory with one allowlisted venue swap |
| `set_paused` | admin | stops deposits, instant withdraw, keeper swaps and crosses. Requests, claims and settles stay open |

- NAV = free USDC + Σ(free leg balance × keeper mark). Free means balance minus the reserved request amounts. It is never the tutorial's `total_assets = USDC balance`.
- Shares: `net × (supply + 1e6) / (NAV + 1e6)`. The virtual offset makes the first deposit 1:1.
- Marks: posted by the keeper from a Raydium pool quote first, Jupiter otherwise (`mainnet-venue.ts`). Deposits and instant withdraws refuse marks older than `max_price_age_secs`. Deposits also refuse marks posted in the current slot and refuse the keeper as depositor.
- Keeper swap allowlist: Jupiter V6 exact-in routes (`route`, `shared_accounts_route`, `route_v2`, `shared_accounts_route_v2`) and Raydium CLMM `swap_v2`. The mock venue exists only in `--features devnet` builds.
- After each swap CPI, every vault token account the venue was given is re-read:
  - only the declared input may decrease, by at most `amount_in`, and never below its reserved amount;
  - the output must rise by at least `min_out`;
  - value out ≥ value in × (1 − `max_slippage_bps`) at the posted marks;
  - no delegate, close authority or owner may change.
  Accounts not passed to the venue cannot be touched.
- A USDC→leg buy may not leave free USDC below `buffer_bps` of the estimated NAV. The estimate uses a balance cache refreshed by `update_prices`, so `keeper_swap` stays within 64 accounts at 25 legs.
- Keeper cycle (`keeper.ts` `planCycle`/`keeperTick`):
  1. post marks;
  2. cross request slices against free USDC, which nets deposits against withdrawals;
  3. exits: one `fulfill_swap` per leg, oldest request first;
  4. rebalance the other legs, one swap per leg per cycle, buying down to the buffer and selling to refill it;
  5. settle converted requests, and deliver unsellable legs in kind to existing owner accounts.
  The keeper wallet never pays for fills.
- Limits: up to **25 legs**. Deposit, instant withdraw, request, marks and swaps all fit in one v0 transaction with the vault LUT. An in-kind claim is chunked at 13 legs per transaction.

## Code

- Program: `programs/nav-vault` (Anchor 0.31), test/devnet venue `programs/mock-swap`. Committed binaries + hashes: `programs/bin/` (rebuild: `scripts/nav-vault-build.sh`, agave 3.0 `cargo-build-sbf --tools-version v1.52`).
- Client: `src/lib/nav-vault/{program,prepare,keeper,config,server}.ts`. Routes: `/api/nav-vault/[id]` (readiness), `/position` (open requests appear as pending withdraw operations), `/deposit/prepare`, `/withdraw/prepare` (exactly one transaction: instant USDC, a keeper request, or request + claim in kind for ≤ 13 legs), and `/claim/prepare` (in-kind claim after the timeout, chunked).
- Flag: server `STOCKLANA_NAV_VAULT_INDEXES` (+ `STOCKLANA_NAV_VAULT_RPC_URL`, `STOCKLANA_NAV_VAULT_PROGRAM_ID`; network must be devnet); client `NEXT_PUBLIC_NAV_VAULT_INDEXES` routes `VaultFlow` to the NAV endpoints. Off = unchanged Symmetry path.
- Tests: `tests/nav-vault.test.mts` (LiteSVM), `tests/nav-vault-api.test.mts`, `tests/nav-vault-jupiter.test.mts` (mainnet build → captured deployed Jupiter V6 + Raydium CLMM TSLA route with the vault PDA as taker).

## Devnet proof

```
solana program deploy programs/bin/nav_vault_devnet.so --program-id <nav_vault keypair> --url devnet
solana program deploy programs/bin/mock_swap.so --program-id <mock_swap keypair> --url devnet
node --experimental-strip-types scripts/nav-vault-devnet.mts --payer <devnet keypair>
```

`--localnet` rehearses the same script against `solana-test-validator`.

**Devnet proof on the exact current build (done, finalized).** The devnet program was upgraded in place to `programs/bin/nav_vault_devnet.so` (sha256 `64801cd0…`). A dump of the deployed program matches the committed binary. This is the same source as the mainnet `nav_vault.so`, which only drops the mock venue. The index `idx-nav-devnet-mag7-pilot` ran with 25 bps entry fee, 5% buffer, 60 s max mark age and a $50 per-deposit cap, which proves the cap path. Mainnet initializes with no cap. SOL for the upgrade came from the devnet test wallet, and 1.67 SOL was returned. Receipts are in `evidence/vaults/nav-vault-devnet.json`. The earlier pre-cap run is `evidence/vaults/nav-vault-devnet-precap.json`.

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
- Operator CLI: `npm run nav-vault -- init|keeper …` (`scripts/nav-vault-cli.mts`). It is dry run by default, `--execute --keypair <file>` sends, and the keeper must not be the admin. Mainnet init flags are `--max-price-age 60 --entry-fee 25 --buffer 500`. The per-deposit cap is off by default (`max_deposit_usdc = 0`), per the captain's decision to remove the $50 cap. The admin can set one later with `set_max_deposit`; no layout change is needed.
- Swaps: Jupiter v2 `/swap/v2/build` is used when `JUPITER_API_KEY` is set, with v1 `/swap-instructions` as the fallback. Both were checked read-only on mainnet with the Mag7 vault PDA as taker. v2 returns `route_v2` and v1 returns `shared_accounts_route`; in both, the PDA is the only signer. Wrapped in `keeper_swap` with the vault LUT, the v2 transactions were 570–801 bytes and 29–48 accounts (see `evidence/vaults/nav-vault-jupiter-v2-readonly.json`). The keeper skips any route that does not fit one packet or 64 accounts.
- App flag: `STOCKLANA_NAV_VAULT_NETWORK=mainnet-beta` (RPC defaults to the server Helius URL) plus the index lists. The public site stays unflipped until the captain decides.

## Not done here

Audit, mainnet deploy, Raydium direct-pool adapter in the TS keeper (on-chain allowlist supports it; `buildCycleRoute` rejects off-curve owners), async large exits, migrating the Symmetry Mag7 vault.
