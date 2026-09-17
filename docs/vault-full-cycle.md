# Full vault cycle

Fail-closed application contract for create → zap-in → mint → keeper rebalance → USDC zap-out. Public Invest Sign stays off until every stage has a matching on-chain receipt. Copy trades are a separate product and are not a substitute.

```sh
npm run vault:cycle
```

Prints the unproven gate. No signer, no RPC send, no Chrome.

## Stages

1. **Create** — deployer signs once. One vault + native share mint, not two. Creation-time WSOL/USDC slots are converted to Raydium-only zero-target support/cash slots; WSOL remains active because native requires it, while USDC is inactive. `createVaultIx` still lists the program's fixed Pythnet custody accounts; those are not vault oracles and are never updated via Hermes.
2. **Zap in** — USDC → catalog legs at target bps (xStock preferred; verified Backpack `.US` when there is no xStock; no DEX lookalikes). Quotes from Raydium pools, Jupiter if no Raydium pool. Never Pyth/Hermes. Preview is estimated, not guaranteed. Unused USDC is returned.
3. **Mint** — host 25 bps in (share carve). Estimated shares stay `null` until a mint receipt.
4. **Keeper** — dedicated hot wallet, not the deployer, not a Phantom click. `update_prices` (Raydium) then rebalance/auctions until on-target. Eligibility is the local AND rule in `rebalance-eligibility.ts`; SDK `isRebalanceRequired` is forbidden. One vault holds at most 100 tokens.
5. **Zap out** — USDC only. The user must not receive a bag of catalog tokens. Host 0 on exit.

## Proven vs unproven

A stage is proven only by a `CycleReceipt` (signature + slot + matching vault/share mint). `publicInvestSignAllowed` also requires `VAULT_RELEASE.publicFundsEnabled`, `nativeUsdcExitVerified` and `publicInvestSign` — all false in this tree. Do not flip those flags because a unit test passed.

Devnet first. Kaku San 5-stock mainnet create is operator-signed and out of band; this tree does not broadcast it.
