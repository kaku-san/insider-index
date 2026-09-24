# NAV vault program

Our unaudited, upgradeable Solana program implements ERC-4626-style shares over USDC and tokenized stock inventory. It is live on mainnet; **it is not audited or permissionless price discovery**.

## Instructions

| Instruction | Authority | Effect |
| --- | --- | --- |
| `init_vault` | admin | Creates index PDA and Token-2022 share mint; pins legs, keeper, fees and limits |
| `deposit(usdc_amount, min_shares)` | user | Entry fee to fee account, net USDC to vault, shares minted atomically |
| `withdraw(shares, min_usdc)` | user | Burns shares and pays immediately from sufficient free USDC |
| `request_withdraw` | user | Burns shares; reserves the exact pro-rata free USDC and stock amounts in a request PDA |
| `cross_request_leg` | keeper | Exchanges a request's stock slice for free vault USDC at the posted mark |
| `fulfill_swap` | keeper | Sells reserved request inventory through an allowlisted venue; credits that request |
| `settle_request` | keeper or owner | Pays converted USDC to the owner when `min_usdc` is satisfied; closes request |
| `claim_in_kind` | owner / keeper / admin | Delivers listed stock slices and reserved USDC **only to the owner**, closes when empty |
| `admin_redeem_in_kind` | admin | Burns holder shares via permanent delegate into a holder-only in-kind request |
| `update_prices` | keeper | Posts marks within the per-update price band; refreshes inventory cache |
| `admin_set_prices` | admin | Explicit price override, outside the keeper band |
| `keeper_swap` | keeper | Rebalances free inventory by bounded venue CPI |
| `set_paused` | admin | Pauses deposits, instant withdrawals, inventory swaps and crosses; recovery remains open |
| `set_keeper`, `set_max_deposit`, `set_lookup_table` | admin | Updates operator, cap or transaction lookup table |

`set_max_price_age` exists in the checked-in source/binary but is **not deployed on mainnet** (see below).

## Accounting and exit safety

- **NAV = free USDC + Σ(free stock quantity × posted mark)**. Free means total less reserved withdrawals; requests are excluded from remaining holders' NAV and keeper spend.
- Deposit shares use `net_usdc × (supply + 1e6) / (NAV + 1e6)`. The virtual share/asset offset mitigates first-deposit inflation. Integer rounding and transaction minimums are enforced on chain.
- Mainnet receipts record a **25 bps entry fee**, **500 bps USDC buffer**, **60-second mark age**, **1500 bps keeper price-move band**, **100 bps swap slippage**, **600-second request timeout**, and no deposit cap.
- Deposits/instant withdrawals refuse stale marks. Deposits also refuse same-slot marks and the keeper as depositor. The client can wait for a new mark and re-prepare; it never treats stale preparation as a completed investment.
- If free USDC is insufficient, the public prepare path creates a reserved withdrawal request. Keeper conversion may take time. A paused/stale vault can prepare an in-kind exit without a fresh valuation. A healthy but illiquid request becomes owner-claimable in kind after its timeout; keeper/admin may deliver it earlier, only to the owner.
- In-kind claims are chunked at **13 legs per transaction**. Starting an exit requires one user approval; a later or large in-kind recovery can require additional claims. There is no promise that every exit ends in USDC or completes in the initial transaction.
- Holder refund authority is not a principal guarantee: the admin can burn a holder's Token-2022 shares through the permanent delegate into their proportional in-kind request, not redirect that holder's assets elsewhere.

After each swap CPI the program checks every supplied vault token account: only the declared input may decrease; spend is bounded and cannot touch reserved inventory; output must meet `min_out`; marked value must satisfy the configured slippage bound; owner, delegate and close authority must remain unchanged. Buys preserve the configured free-USDC buffer floor using the refreshed balance cache.

Mainnet CPI venues are Jupiter V6 exact-in routes and Raydium CLMM `swap_v2`. `programs/mock-swap` is accepted only by the separate devnet-feature build. No Pyth/Hermes client is used.

**Trust limits:** keeper-controlled marks and a per-update band are not an independent oracle and do not prevent every manipulation. Admin price override, permanent delegate and upgrade authority are privileged. Token issuers, market liquidity, keeper availability and program bugs remain risks. Pause preserves recovery, not a guaranteed market value.

## Tradable slices

Complete disclosed books remain visible. `scripts/nav-vault-slices.mts` selects names with qualifying route evidence at $0.05, $10 and $100 and at most 2% price movement between the $10 and $100 fills. It renormalizes kept disclosed weights, records all exclusions and caps slices at 25 legs (largest weights first). Fewer than three legs or under 30% of disclosed weight stays Research.

The on-chain program supports 25 legs; the current operator init CLI conservatively refuses more than **16**. This cleanup does not raise that guard. The eight recorded vaults fit it.

`src/lib/nav-vault/slices.ts` prefers the service-role published slice table and falls back to committed JSON. Disclosure is shown only when the slice mint set matches the on-chain legs, including while paused or deposits are disabled. `slice-notes.ts` owns the asterisk copy; the complete Allocation book stays unfiltered. Tradability observations are dated, not guaranteed future fills.

## Deployment and build evidence

| Network | Program |
| --- | --- |
| Mainnet | [HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB](https://explorer.solana.com/address/HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB) |
| Devnet | [2YwNAuwjYcEy1g63iRE3985GJzwt3BP2UVoud7pFxqCr](https://explorer.solana.com/address/2YwNAuwjYcEy1g63iRE3985GJzwt3BP2UVoud7pFxqCr?cluster=devnet) |

Mainnet upgrade authority / vault admin: `5mVkJHMu2A25x45FsN5qrp5uwLJjevbPz4ziArNp1qaJ`. Keeper: `GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq`. These are public addresses, not signing credentials.

- [Mainnet deployment and keeper receipts](../evidence/vaults/nav-vault-mainnet.json)
- [All eight vaults and share mints](../evidence/vaults/nav-vault-slices-mainnet.json), also linked in [README](../README.md#mainnet-deployment)
- [Devnet deposit, keeper, USDC exit, pause and in-kind proof](../evidence/vaults/nav-vault-devnet.json)

**Do not equate the current build with the deployed mainnet bytes.** The recorded deployed SHA-256 is `7e8e8d65b4be4f22e911d93924973c373994762e82b78294ce4932ccfff619f5`. The committed `nav_vault.so` is `b30f84b16c6550319eb42181be02ea11ebb8953a33df6b04d2c83f0466e1a101` and adds `set_max_price_age`. Mainnet has not been upgraded to that build; the live 60-second setting is unchanged. Receipts are dated evidence, not a fresh chain attestation.

## Rebuilding and tests

```sh
# Requires Rust and the Agave Solana SBF toolchain; builds locally, never deploys.
bash scripts/nav-vault-build.sh
npm run typecheck && npm test
```

The build script pins SBF tools v1.52 and updates `programs/bin/MANIFEST.json`. After any Rust edit, rebuild and commit the binaries/hashes together. Tests use hash-checked binaries in LiteSVM; `nav-vault-jupiter.test.mts` additionally executes captured deployed Jupiter/Raydium programs with a NAV PDA taker. Offline fixtures are not proof of present liquidity or a funded live roundtrip.

For devnet-only operator rehearsal, `scripts/nav-vault-devnet.mts --payer <devnet-key-file>` requires separately deployed devnet NAV and mock-swap programs. Never supply a mainnet key to that script. Deployment and upgrades are explicit operator actions, not part of app build or test.
