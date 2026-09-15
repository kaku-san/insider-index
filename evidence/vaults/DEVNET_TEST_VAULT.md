# Tiny devnet vault attempt

Creation, **0.1 SDK-devnet-USDC contribution**, and deposit lock **finalized**. The native intent is pending **`update_prices`**; share supply remains **0**. This is an execution-test vault, not a Pelosi basket, production index, or completed deposit roundtrip.

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

**Settlement remains NOT_RUN.** No keeper, price-update, auction/swap, mint, share transfer, or redemption was executed. Current oracle freshness and route readiness are not certified; this receipt does not establish whether settlement would succeed. To continue, reconcile and resume **this existing intent at `update_prices`**, then validate the remaining native settlement stages within an authorized budget. Do **not** repeat initialization/contribution, create another vault, or report a completed deposit roundtrip merely because contribution and lock finalized.

## Release limits and validation

- On-chain deposits default to enabled; automation, LP, force and custom rebalance are disabled. Stocklana app/public-funds gates and registry were **not** enabled or changed.
- Host entry fee read back at **25 bps**, other host/creator/manager/vault fees at zero. Protocol fees are separate; this is not an all-in fee quote.
- Test metadata is on-chain name/symbol only, URI empty. No immutable hosted metadata, role separation or production manifest readiness is claimed.
- Start-price SDK input was `"1"`; native formatted value is approximately `0.000001` (SDK scaling). No bootstrap fairness or NAV proof is claimed with zero shares/backing.
- Creation readback checked finalized receipt hash, creator/host, mint authority/decimals/supply, basket mints/weights, fees, remaining SOL and then-absence of an owner intent. Continuation checked all three finalized receipt hashes, exact USDC owner/vault deltas, remaining original SOL budget, zero shares and the now-existing pending native intent.
- Repository tests: **73 passed** and `npm run typecheck`: **passed**, rerun after the funded continuation. The initial run had required `next typegen` to regenerate stale worktree route types. These checks do not prove native settlement.
- No secret key, signed wire transaction, or private deployment journal is committed. This operational evidence is not a general-purpose signing endpoint or an audited live-funds release.
