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

**Devnet proof on the exact current build (done, finalized).** The devnet-feature build (mock venue allowed) now has its own devnet program id, `2YwNAuwjYcEy1g63iRE3985GJzwt3BP2UVoud7pFxqCr`. The mainnet build stays at `HWHf…`. Both come from the same source; only `declare_id` differs, by cargo feature. A dump of the deployed program matches `programs/bin/nav_vault_devnet.so` (sha256 `dd36ecdf…`). The old HWHf devnet program was closed to reclaim its 1.77 SOL of rent. The index `idx-nav-devnet-mag7-v2` ran with the mainnet params: 25 bps fee, 5% buffer, 60 s marks, 15% band, no cap, 600 s request timeout. Receipts are in `evidence/vaults/nav-vault-devnet.json`; earlier runs are in `nav-vault-devnet-pilot-v1.json` and `nav-vault-devnet-precap.json`.

| Step | Signature / result |
| --- | --- |
| deploy (devnet id) | `5e11FW7U2YvhpeP1gXHwHDNYq6M33RFTWBsX55pRFL6FBabNEj78du32uNaKUmChjMXMYcvHpa5yJ78ygxE2zu2k` |
| init_vault | `62L1oDNgPDU9VCuyuMD4dyR6HBA4w5Ey8nie7hwsXuyPpK65qQYqBNc9EoAMK5pZcbCmAo6nahGAc12xFHCQHPhG` |
| keeper +20% mark (simulated) | refused with `PriceMoveTooLarge` |
| ONE-signature deposit of 50 → 49.875 shares, 0.125 fee | `3eTK1bFrX4L8v5EQAVb3YqBQDq2wdXBUDBdw63hMwZQL3DahnMWTHTAaouyHpGtb2ah63MAjj4gKXp9F2vaSKecY` |
| keeper buys, buffer ends at 5.50% | `K7bL7orSuWufDbusXsRuChHW8himQAWKyBAv25VQWsg6yHcygafVo3EGNKVHehUyp4xRLH9bKwZ7n2QRmkM7DnL` / `3RU8Bq6UJhvSywHsFcF7wa2YTrhFv2WFgjbmBuJvZmeJMxTALCj3ELFPjTbdHYuJR9TbgohHoXcTVLytHc4UEwK1` |
| ONE-signature instant USDC exit (2 shares → 1.999995) | `25xeFVwNHXEKqGkbij6M3uJy17XfcXbtFBRBdFYz1GWtKKbaLtHDaxcH6nU2pnAQkPc8q6VekQ9A8SCJJJhcn3yP` |
| ONE-signature keeper request (20 shares) | `5FZ19u2Nxxetqd69aU8nXCkqPwQKZjBgm4TD2xjw2wEgy2Rfu82Go2L6RXv7Z3enPvcfNrcYJbJy3AkZwxuFYY4A` |
| keeper fulfill A / B, then settle: 19.999865 USDC paid (estimate 19.99995) | `j4hQLpR6DqCeQPwAFacoU6rayNevm9C3TrkfD1YfowYqhGBaoihJCKD7Vcvpkae44k61YWJiMVddRQjnN86TdR7` / `5MoUVp7YEoEYeb1C7KFP8Z8ZrjZCmPKEtyzVg964Fuw9LnCk2cQNpL2fqyCJXtaBML4ENdhoQuR9MWGGbd8wpbKH` / `RLtPWJYwpd4rjgtk1DuW8RzsdxKN7NvUcuEgZLtHXQySJ4zFQTDJJJ2QwTXX1JNJpmMkjDTY9pJdLGmaWSwSysn` |
| admin pause, then deposit (simulated) | refused with `Paused` |
| ONE-signature in-kind exit while paused (request + claim): 0.432685 USDC + 82327 A + 2744232 B | `3DFGNYJenatEVMbBCMdvyVBXzT9akHuUZLXaQsWZaDJfnZctGuA1RYQN2esA5H9vBJ8H2jYx3LhynxJcAnVRYHdC` |

Final state: supply 0, nothing reserved. Every readback matched the prepare estimate, and the keeper wallet's USDC did not change.

## Mainnet (deployed, 2026-09-23)

- Program `HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB`, built from `programs/bin/nav_vault.so` (sha256 `7e8e8d65…`) with the devnet feature off, so only Jupiter V6 exact-in routes and Raydium CLMM `swap_v2` are allowed. A dump of the deployed program matches the committed binary. Upgrade authority and vault admin: `5mVkJHMu2A25x45FsN5qrp5uwLJjevbPz4ziArNp1qaJ`. Deploy signature: `rvMVLbjoizmGfJL8DZNRkCSyj4fkAjKigAqmBuX2jjccVTsF7g3tVwsTEJdNsUS4oSABw8Zb5g88MjVGJEGD8s6`.
- New Mag7 NAV vault for `idx-theme-mag7-caucus`:
  - vault `2w5g5aXmQj6o1cZSYbpV6R6rdK9KK7zAeJJRZu9PseM6`;
  - Token-2022 share mint `BZw8SegRiJmqmKgBDt5npmPo2dvsnv2nDPXvLQM6Mv4A`;
  - vault USDC account `CtgkQ6GGKE6KH6P8sTQkgLWS8NcUyR2ePQjnksU5qDdf`;
  - fee account `9bhtfyxu5dtzzR9Z5mHitvVLXwehZQAwfUFhVFwb8Fuo` (the deployer's USDC ATA);
  - LUT `482Et7YNkNQJS2cqhaRgugoNmjE3GmLqiSQFbZ81wmAr`;
  - keeper `GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq`.
  Params: 25 bps entry fee, 5% buffer, 60 s marks, 15% band, 100 bps swap slippage, no deposit cap, 600 s request timeout. The legs and weights are the DB Mag7 definition, 7 xStocks (Token-2022). init_vault signature: `nsZApxhdwwTE93ZMNgKVGtk9X16r65ov3pChenNBqfKieoqQGBmD1ZNV5MGmkSzBk85BCyPNGWEk62SrJCfrW6f`. All receipts are in `evidence/vaults/nav-vault-mainnet.json`.
- Not done yet: keeper marks and swaps, which run from the server key (`npm run nav-vault -- keeper --index idx-theme-mag7-caucus --network mainnet-beta --execute --keypair <server key> [--loop 30]`); any deposit; flipping the public site. Deposits refuse until the keeper posts fresh marks. The live Symmetry Mag7 vault is untouched.
- Cost: 2.3403 SOL spent (program rent 2.29797, recoverable with `solana program close`); 0.4597 SOL left on the deployer.
- Operator CLI: `npm run nav-vault -- init|keeper|pause|unpause …` (`scripts/nav-vault-cli.mts`). It is dry run by default, `--execute --keypair <file>` sends, and the keeper must not be the admin.
- Keeper swaps try **Jupiter first**, using v1 `/quote` + `/swap-instructions` with shared accounts. Routes are restricted to CPI-safe DEXes (`JUPITER_CPI_SAFE_DEXES`), because prop AMMs such as Quantum reject being called via CPI. Jupiter v2 `route_v2` failed on mainnet with `InvalidTokenAccount` (6025) when invoked via CPI with the PDA taker, so v2 is used only for marks. If Jupiter has no working route for a leg, the fallback is a direct Raydium CLMM `swap_v2` on the persisted pool (`raydiumSwapBuilder`: quoted for the keeper wallet, then rebound to the PDA and vault accounts). Every Mag7 leg simulated OK on mainnet through both paths. Earlier checks: Both were checked read-only with this vault's PDA (`FM2B3N2f…`) as taker: the PDA is the only signer, and the wrapped transactions were 570–801 bytes and 29–48 accounts (`evidence/vaults/nav-vault-jupiter-v2-readonly.json`).
- App flag: `STOCKLANA_NAV_VAULT_NETWORK=mainnet-beta` + `STOCKLANA_NAV_VAULT_INDEXES` + `NEXT_PUBLIC_NAV_VAULT_INDEXES`. The RPC defaults to the server Helius URL. **Branch preview:** this branch's Vercel PREVIEW deployment serves Mag7 from the mainnet NAV vault with no env change (`navVaultBranchPreview` in `config.ts`, `navVaultEnabledFor` in `vault-api.ts`). It is never active in production or on the self-hosted site.
- Server keeper: container `nav-vault-keeper` on barelystable, running `node:22-bookworm` against a source copy at `/home/deploy/insiderindex/nav-vault`. It reuses the existing checkout's `node_modules` (read-only), the Mag7 keeper key (read-only) and `mag7-keeper.env`, and runs `npm run nav-vault -- keeper … --execute --loop 50 --priority-micro-lamports 5000`, a mark roughly every 50–60 s (captain's cost choice). Near the end of that window a deposit can hit `StalePrices` and needs a retry. The existing `mag7-keeper` container is untouched.

## Not done here

Audit, mainnet deploy, Raydium direct-pool adapter in the TS keeper (on-chain allowlist supports it; `buildCycleRoute` rejects off-curve owners), async large exits, migrating the Symmetry Mag7 vault.
