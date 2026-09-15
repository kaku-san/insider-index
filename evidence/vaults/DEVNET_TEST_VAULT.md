# Tiny devnet vault attempt

Creation, **0.1 SDK-devnet-USDC contribution**, deposit lock, price update and share mint **finalized**, twice: the first deposit settled through the creation-time Pyth-type oracle accounts (no Hermes), the vault's oracles were then edited to **Raydium CPMM only**, and a second 0.1 SDK-USDC deposit settled end to end with **Raydium-only prices** (see [Raydium-only settlement — September 15, 2026](#raydium-only-settlement--september-15-2026)). Share supply is **199990**; the wallet holds **198494**. This is an execution-test vault, not a Pelosi basket, production index, or audited public-funds release. Earlier sections keep their original observations.

## Identity and receipt

- Network: devnet; RPC `https://api.devnet.solana.com`, genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Existing Symmetry V3 program: `BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate` (executable verified).
- Vault: `Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8`.
- Native share mint: `Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A` (6 decimals, supply **0**).
- Name/symbol read back: **Stocklana Devnet Test / SLDTEST**.
- Creator and host: `C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB`.
- [Finalized creation transaction](https://explorer.solana.com/tx/5FZHgG2SxpEMY9FC45hjCq4FTYJG5Pp3Lu6DYuZrXstivS7WiEJhjUpmKQEPLi622fVc3gAhcYa6ZwSL59tbz53b?cluster=devnet), slot **498565132**.

[Historical creation receipt and unfunded simulation](devnet-test-vault.json) records the initial message hash, balances and native readback checks. [Creation-time SDK state](devnet-test-vault-state.json) records the complete small basket/configuration. [Funded deposit receipts](devnet-test-deposit.json) and [post-lock intent](devnet-test-deposit-intent.json) record the later continuation; the historical files intentionally retain their original observations. The earlier `devnet-funded-preflight.json` is historical: its missing-base blocker was resolved by supervisor-authorized rebase onto `f86af32`.

## Basket and costs

The SDK/native creation default is a **50% WSOL / 50% SDK devnet USDC** test basket, verified after creation:

| Mint | Decimals | Weight |
| --- | ---: | ---: |
| `So11111111111111111111111111111111111111112` | 9 | 5,000 bps |
| `USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT` | 6 | 5,000 bps |

Both mint accounts were read from devnet and verified as initialized classic SPL mints. No securities mints were certified. Oracle settings exist on the vault; current price freshness and swap routes are **not verified**.

- Initial wallet: **5 SOL**; after creation: **4.809072640 SOL**; after deposit/lock: **4.807493578 SOL**.
- Creation alone: one finalized broadcast; wallet debit **0.190927360 SOL**, including **0.000030 SOL** transaction fee, account setup/rent and wrapped SOL. Wallet debit is not all an irrecoverable fee.
- The SDK wrapped **0.01025 SOL** into the creator's WSOL account; creation did **not** credit it to native vault bounty balance (read back **0**). No backing contribution was made.
- Creation was simulated under a stricter **0.25 SOL** subcap before loading the authorized signer. SOL authorization remains capped at the original **5 SOL**; no airdrop, additional SOL funding, mainnet RPC, or mainnet transaction was used. SDK-USDC funding arrived separately for the continuation below.

## Deposit continuation — September 15, 2026

The initial attempt used `NativeVaultBuilders.deposit` / `@symmetry-hq/sdk@1.0.22` to prepare **0.1 SDK-devnet USDC** (`100000` raw units), but stopped without broadcasting because that mint was absent. The SDK returns initialization and contribution batches; lock is separate. A later check at 05:40 UTC still found only Circle devnet USDC (`4zMMC…ncDU`) and WSOL. At 05:54 UTC the **exact SDK mint** was verified at **1.833029 USDC**, resolving the funding prerequisite. Circle USDC was not spent.

Reused the existing vault and native share mint. The contribution builder for an existing intent (`depositTokensTx`) was used after finalized initialization, followed by `NativeVaultBuilders.lock`. Each stage was decoded for account/instruction review, simulated, bounded by a **0.25 SOL** per-stage subcap and the remaining original budget, and reconciled against its finalized message hash. No app signing route was enabled.

| Stage | Finalized slot | Transaction |
| --- | ---: | --- |
| Initialize deposit intent | 498622874 | [Receipt](https://explorer.solana.com/tx/2Yo8MQENKUnbYeiXFzZHwSxSF1Q3CCcNRYHNeNXZsaWo1Bs3wJMUZGupMW246SfMauD2RorboDnHEVX2A1qTTjkn?cluster=devnet) |
| Contribute 0.1 USDC | 498623114 | [Receipt](https://explorer.solana.com/tx/LJdAP9ckLDBrbrNEXjwEBvFLg8Pe7JHtEbCQ7jiLGVMiWpxbx9fqHijWEnRoUVALArBNMatPciecbtezAXhmSf5?cluster=devnet) |
| Lock deposit | 498623256 | [Receipt](https://explorer.solana.com/tx/nW52nuqsokCatXPX8tuagmWyWaRfrwW4CLAwS7NqsGDBcMewLgafcYtTATz1hd2VZWuLZnD5kpzGV3y9a1S8RN2?cluster=devnet) |

- Wallet USDC ATA `DTJXN8s64Ut8JYF8944XaM3mtt93ehpXxAwyMxvFafYY`: **1.833029 → 1.733029 USDC**.
- Vault USDC ATA `9yU5Rd8qtcJzwUKRVv87jABwzmbbMHVC2yDDFGzdsxkt`: **0 → 0.1 USDC**. These tokens are an unsettled contribution, not evidence of minted shares or finalized NAV backing.
- Native intent: `8YE4XGm767rVxFhEYr8snLDxgRf1G9YLCPwPBKD3QBCL`; next action **`update_prices`**. Native intent records `100000` raw SDK USDC. Wallet share balance and mint supply remain **0**.
- Deposit-stage wallet SOL debit: **0.001579062 SOL**, including **0.000090 SOL** transaction fees. Initialization also moved **0.00089 WSOL** from the previously wrapped creation balance into the native bounty; it is already inside the original budget and is not added twice to the cumulative wallet debit.
- Cumulative wallet debit including creation: **0.192506422 SOL**, leaving **4.807493578 SOL**. Four finalized transactions total; no second vault, mainnet RPC, SOL top-up, or public-funds enablement.
- One earlier initialization submission was rejected during RPC signature verification because the private one-off signer cleared an aliased key buffer too early. It had an invalid local signature, no chain status, no intent account and no SOL debit. The signer was corrected to copy the buffer and verify Ed25519 locally before submitting; the rejected attempt was reconciled before the successful initialization. No secret bytes or signed wire payloads are committed.

**Settlement of this first intent was later run outside this repository's tooling** (historical statement retained below in the Raydium section): `update_prices` at slot 498665208 read the creation-time **Pyth-type** oracle accounts (`type: 0` in program logs; devnet price accounts read as-is, no Hermes update posted, nothing paid) and `MintBasketHandler` at slot 498665356 minted **99247** shares to the wallet plus **748** protocol/host fee shares. The oracle edit to Raydium and the Raydium-only second deposit are recorded in the next section.

## Raydium-only settlement — September 15, 2026

Policy: Symmetry prices come from **Raydium pools only**. No Pyth oracle type, no Hermes client, no `HERMES_*`/`PYTH_*` environment, nothing paid. Code: [`src/lib/index-vaults/raydium-oracles.ts`](../../src/lib/index-vaults/raydium-oracles.ts) (rejects `oracle_type: "pyth"`, builds native `update_token_prices` without the SDK's Hermes-backed batch builder) and [`src/lib/index-vaults/devnet-settle.ts`](../../src/lib/index-vaults/devnet-settle.ts) (`npm run vault:settle:devnet`, [procedure](../../docs/devnet-vault-settle.md)). Machine receipts: [`devnet-raydium-settlement.json`](devnet-raydium-settlement.json); final readback: [`devnet-raydium-settlement-readback.json`](devnet-raydium-settlement-readback.json).

### Oracle edit (pre-existing on chain, verified by readback)

Both basket legs now carry exactly one oracle of type **2 (Raydium CPMM)** on pool `5Eu2G2USTy1pqphmQzQ2SBXWrBq5sdhgEh7hso9R2xix` (WSOL/SDK-USDC; token0 = WSOL vault `Aw93pmXP52u6WSW2HcafRxua1LDht5MZhhXaaR7qCjsN`, token1 = USDC vault `CPLUA2NTYSGjsB1E9iXT3MrPn69WRFJvKTdJZw5NdEjh`, observation `7LnqjXdqJEdccWZQs5YJobQ8MDmcK4sG2oo4Ty4LBC8c`, all in vault lookup table `64g9E6EcsuvbJD5Rk1z3cc8AUWcPDi2LDCSMB2mMWNQQ` slots 10–13). WSOL = **base** side quoted in USDC; USDC = **quote** side quoted in WSOL (this is the Quote/Base patch the devnet pool needed). Staleness 3600 s, TWAP 30/120 s, confidence/volatility/slippage thresholds 9999 bps, min liquidity 0 — devnet test values, not production thresholds. Edit receipts (finalized, wallet-signed): WSOL [`ea8ra8…`](https://explorer.solana.com/tx/ea8ra8ii1s2yrxyNMjYiSHBbsDDDn1W8cZh5NTon2bdSSE3hWifGkBTwHjoxemrJuCCA7KCXcXtJDvCWnnvEThJ?cluster=devnet) + [`2XNnj7…`](https://explorer.solana.com/tx/2XNnj7c5CdcavSV2w9NQMVxWHPM8TmpxftHBsMHzUR3kBpRYF1o1cgiu7EKuwq9zHrhdV7Sfc2tGZneKWCvmC2Jr?cluster=devnet) (slots 498672984/498672992); USDC [`4em1St…`](https://explorer.solana.com/tx/4em1StKarxwKJuGbp2ZPhpmEfsroufShmieCXS2UQf5c6tjDu5BUMj5ZVnvEUeAHRmu6uiUVfqftRYuz9KAKCzzg?cluster=devnet) + [`4HkfmT…`](https://explorer.solana.com/tx/4HkfmTFiKcNXPq738iCvgBBmoqQLq1HTJ4mneG2bbPwTG4R7isVPo7sHUJfPDvrxPz1Ea7wseLrorx9ndDiuPRBD?cluster=devnet) (slots 498674976/498674980). A vault-level rebalance intent `BSBqMSbSVFcT7FPQ1rR5KYLdqqvA5T6xjgcv9E3PiVXV` then proved Raydium `update_prices` (`type: 2` both legs) at slot 498676785, [`2AVDAV…`](https://explorer.solana.com/tx/2AVDAV7aJPz1cFMVcQLhpFe1atwFwNFYueRKS6uTHsMssbPa8cKhUp8tSCHKVmX81Yh4nF8v494CHdkievSU9Ase?cluster=devnet).

### Roundtrip with this repository's settler (all finalized, signer `C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB`)

| Stage | Intent | Slot | Transaction |
| --- | --- | ---: | --- |
| Claim bounty / close first deposit intent (post-mint) | `8YE4XG…` | 498691621 | [`BXRYRQ…`](https://explorer.solana.com/tx/BXRYRQcVeXjGhnSb8GfjC6ycCTw65ANCCxEKGTofUfNAorqk2fsfCvj5fw7NTSaXsp69ST4kXUXCZnHuNDMNnwm?cluster=devnet) |
| Claim bounty / close vault rebalance intent | `BSBqMS…` | 498691760 | [`29x1EK…`](https://explorer.solana.com/tx/29x1EKsJD5oH374VqNFBXiuyR6CzdneaFjg8ruZvBKXbfaUXaYKQ3o4qM7i6gXxSZwz9T6SHpo1QXVXCkb9Ao8Uu?cluster=devnet) |
| Initialize second deposit intent | `8YE4XG…` | 498692075 | [`vKh8cM…`](https://explorer.solana.com/tx/vKh8cMu14HhbPK3syDBnWPZR6hzv5FhvdAmPBLU54hUt7RMSDLsspS7FE3FtpPHyWKphz22nhrcGZXichy6ahBs?cluster=devnet) |
| Contribute 0.1 SDK-USDC (`100000` raw) | `8YE4XG…` | 498692134 | [`2oUAr6…`](https://explorer.solana.com/tx/2oUAr62jfC4WrK6jMcvg6n2NpeTX97gE6WbU62q9VhT17Nkvup3uyWvqvPSnxLicTS8Jr9H3ZaY1FKCRToAX5csf?cluster=devnet) |
| Lock deposit | `8YE4XG…` | 498692274 | [`5pxkxz…`](https://explorer.solana.com/tx/5pxkxzb5673TnHk2qSDiCWk7XGFLx2gLvB8LSMJNMiKUn6BHu8bPSLoJbKqcyZtm3296mALHUPgpcoKnYeQTqkyK?cluster=devnet) |
| **`update_prices`, Raydium CPMM only** (`type: 2`; WSOL 81.789503334, USDC 1.229878984) | `8YE4XG…` | 498692652 | [`3Pz6iL…`](https://explorer.solana.com/tx/3Pz6iLLw5wR9mn1beuHAg7kMUN7zNkxG3TrQ5TZxH7dmtYWoH8h2FJKgCAH3mWQBZG57Aas5L2GWQCs3SmyK4Q42?cluster=devnet) |
| **Mint** (`deposit_value` = `self_tvl` = 0.122987898; wallet shares 99247 → 198494; fee shares 748 → 1496) | `8YE4XG…` | 498693972 | [`2LAh1f…`](https://explorer.solana.com/tx/2LAh1fzXd4Nz9YzR5ikPEegr1Lai2hrVe4ziptFABc7C6CBhADUYCJ7Jcd77idxePyd5oMKvCysKNwZmLxaeo7bR?cluster=devnet) |
| Claim bounty / close intent | `8YE4XG…` | 498694240 | [`6BGDF5…`](https://explorer.solana.com/tx/6BGDF5AEY6F4hWDARQpqEbr2w3tqAPv2LVh9p1EnRZHXdN5Zv9Pj47DX8Mjb4LJaQ1KNgQ4UTwAv8Xvn6ANdZYv?cluster=devnet) |

- The price-update instruction loaded only the eight Raydium pool/vault/observation accounts through the vault lookup table; no Pyth feed account, Wormhole VAA or Hermes request was built, and the process refused to start with any `HERMES_*`/`PYTH_*` variable set. The Symmetry program's instruction layout also names two fixed WSOL/USDC custody reference accounts (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX`) as program constants; they are not vault oracles, cost nothing and are not updated by this integration. On devnet the USDC leg therefore prices at ~1.23 because the pool's ~82 USDC/SOL ratio differs from the program's stale WSOL reference; both the deposit and vault TVL used the same prices, so the mint ratio was 1:1 with existing shares.
- Wallet after the roundtrip: **4.777677715 SOL** (session debit **0.000250622 SOL**, all transaction fees; bounty WSOL returned to the wallet's WSOL account), **3.750623 SDK-USDC**, **198494** shares (`5NtgPkFiSqbP1H3Xgk3L48ioWLJouPFivaUqWJKQmhMZ`). Vault: **0.2 SDK-USDC**, 0 WSOL, share supply **199990**, no open intents, `activeRebalance` 0.
- The vault remains 100% USDC against a 50/50 target: no flash-swap settlement or automated rebalance was run; auctions elapsed without swaps and mint proceeded per the SDK keeper flow. Redemption, share transfer, fee claims, and any mainnet action remain **NOT_RUN**. Nothing here enables app deposits or public funds.

## Release limits and validation

- On-chain deposits default to enabled; automation, LP, force and custom rebalance are disabled. Stocklana app/public-funds gates and registry were **not** enabled or changed.
- Host entry fee read back at **25 bps**, other host/creator/manager/vault fees at zero. Protocol fees are separate; this is not an all-in fee quote.
- Test metadata is on-chain name/symbol only, URI empty. No immutable hosted metadata, role separation or production manifest readiness is claimed.
- Start-price SDK input was `"1"`; native formatted value is approximately `0.000001` (SDK scaling). No bootstrap fairness or NAV proof is claimed with zero shares/backing.
- Creation readback checked finalized receipt hash, creator/host, mint authority/decimals/supply, basket mints/weights, fees, remaining SOL and then-absence of an owner intent. Continuation checked all three finalized receipt hashes, exact USDC owner/vault deltas, remaining original SOL budget, zero shares and the now-existing pending native intent.
- Repository tests: **73 passed** and `npm run typecheck`: **passed**, rerun after the funded continuation. The initial run had required `next typegen` to regenerate stale worktree route types. After the Raydium-only settlement, **162 tests** pass including `tests/raydium-oracles.test.mts`. These checks do not prove native settlement beyond the recorded receipts.
- No secret key, signed wire transaction, or private deployment journal is committed. This operational evidence is not a general-purpose signing endpoint or an audited live-funds release.
