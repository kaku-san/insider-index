# Existing devnet vault: native redemption preflight

This is a **read-only execution-test tool**, not an app withdrawal release. It does not alter the investment UI, create a vault, load a keypair, sign, broadcast, run keepers, request an airdrop or trade to USDC. It always stops closed. The existing public app's investment gates remain unchanged.

## Run

```sh
npm run vault:redeem:preflight -- --shares-raw 1
```

The amount is an exact positive integer in native share base units (6 decimals); `1` means 0.000001 shares, not one share. Values above JavaScript's safe integer limit are rejected because the pinned SDK accepts a number. Exit **2** means an observed safe stop; exit **1** means invalid input/RPC/identity/encoding failure. Neither means redemption succeeded. There are no wallet, network, vault or broadcast flags.

Identity is fixed in [`devnet-redeem.ts`](../src/lib/index-vaults/devnet-redeem.ts):

- RPC: `https://api.devnet.solana.com`; devnet genesis is checked before native reads.
- Existing vault: `Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8`.
- Share mint: `Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A`.
- Funded test wallet: `C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB`.
- Native program: `BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate`.

The observer checks native program/existing vault identity, creator/host, initialized classic SPL share mint, authority and decimals. It sums actual owner share accounts separately from unfrozen associated-account shares (the SDK burns from the ATA). Any existing owner intent blocks another burn, even if it cannot be decoded. Active vault rebalances are conservatively blocked.

## Observed safe stop

[`devnet-redeem-preflight.json`](../evidence/vaults/devnet-redeem-preflight.json) records a finalized read at slot **498626560** on **2026-09-15**:

- Wallet shares **0**, spendable ATA shares **0**, total share supply **0**.
- Wallet SOL: **4.807493578**; SOL funding does not imply ownership of vault shares.
- An owner intent account exists at `8YE4XGm767rVxFhEYr8snLDxgRf1G9YLCPwPBKD3QBCL`. Its stage/effects are **not attested by this tool**; do not overwrite it, cancel it blindly or initiate another burn.
- Native allocated basket: WSOL `So11111111111111111111111111111111111111112` and SDK devnet USDC `USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT`. This is an execution-test basket, not politician holdings or production securities.
- No withdrawal transaction built for this wallet. No simulation, signing, broadcast or redemption performed; no test funds spent by this task.

Reads are a dated observation, not an atomic snapshot or continuing assertion about the wallet. Re-run before any future work. Do not seed/buy shares or create a second vault merely to make this redemption test pass.

## Documented native path and verification limits

Primary references, retrieved 2026-09-15:

- [Symmetry SDK: sellVaultTx](https://docs.symmetry.fi/sdk/reference#sellvaulttxparams-promisetxpayloadbatchsequence)
- [Symmetry withdrawals and keep_tokens](https://docs.symmetry.fi/concepts/rebalancing#withdrawals)
- Installed `@symmetry-hq/sdk@1.0.22`: `dist/index.js`, `dist/instructions/automation/rebalanceIntent.js`, `dist/states/basket.js`.

The documented **native in-kind** flow is:

1. Fetch the current vault and take **every allocated composition mint**, including inactive/zero-weight residual slots. Do not filter by target weight or buy catalog. Do not pass an empty/partial `keep_tokens` list: that selects a rebalance/auction path, not a guaranteed USDC exit.
2. Call `sellVaultTx({ seller, vault_mint: shareMint, withdraw_amount: rawShares, keep_tokens: allMints, ... })`. The SDK builds a withdrawal-intent initialization, not a completed redemption. It can also wrap SOL for a bounty and allocate rent. Documented fast withdrawal skips price updates/auctions; withdrawal fees still apply.
3. **Only after a separately authorized and verified sell**: fetch the owner/vault intent PDA from chain, verify owner, vault, withdrawal kind, burned amount, complete keep mask/mints hash and actual redeem readiness. A finalized sell signature alone does not prove tokens were received. Resume the existing intent rather than burning twice.
4. Build `sdk.redeemTokensTx({ keeper: owner, rebalance_intent: verifiedIntent })` from the newly fetched intent. The owner can invoke this without running a keeper bot. Check all expected destination ATAs: the docs warn that missing ATAs can cause assets to be skipped when a different keeper submits redemption. This step cannot be faithfully built before the sell creates its on-chain state.
5. Verify finalized receipts **and** share burn/supply changes, each underlying owner token-account delta, fees and remaining claim balances. Resume unclaimed tokens if necessary; do not mark the operation complete from a signature alone. `claimBountyTx` is a separate documented cleanup/recovery step after redemption; cancellation/refund safety is not established here.

This task verifies the documentation and **SDK wire encoding**, not deployed economic effects. The tests execute real `sellVaultTx` against explicit read-side fixtures and decode its serialized message: withdrawal kind, raw burn, rolling native mints hash, full u128 keep bitmask and keep-all flag. Empty/partial keep lists and tampered amounts/mints/signatures fail inspection. Inactive composition coverage, no-shares/no-ATA/intent gates, devnet restriction and RPC send denial are behavioral tests, not source-text checks.

If the wallet eventually has sufficient shares and no pending operation, the CLI may build an **internal unsigned sell diagnostic** and emit only its message hash/keep-mask check. It still returns `NATIVE_REDEEM_ROUNDTRIP_UNVERIFIED`, with no transaction bytes or signing option. Encoding checks are not a complete transaction-spend audit and must not be repurposed as broadcast authorization. There is no environment-variable release override.

Before adding a funded execution path, require verified native sell → redeem → residual-claim recovery evidence on this same devnet vault, current fee/config attestation, complete message/account/spend inspection, simulation and explicit bounded spending authorization. No native-USDC payout, all-in exit quote, minimum basket output, cancellation refund or production readiness is claimed.

## Local validation

- `npm test`: **100 passed**, including 9 redemption tests.
- `npm run typecheck` and `npm run build`: **passed**.
- ESLint on the new module, CLI and test: **passed**.
- Full `npm run lint`: **5 existing errors / 4 warnings** in unchanged UI files (`index-ticket.tsx`, `trade-approve.tsx`, `providers/ui-provider.tsx`, `feed-view.tsx`, `person-avatar.tsx`). These were not silently fixed as part of the devnet task.
- no-mistakes validation/shipping is a separate supervisor-directed gate; local checks do not claim CI readiness.
