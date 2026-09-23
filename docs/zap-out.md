# Zap-out

Public cash-out is the staged inverse of zap-in. It is not an empty-keep auction and it is not an atomic shares-for-USDC promise.

`POST /api/indexes/{id}/withdraw/prepare` loads that index's persisted vault and `vaultLegs`. N is the definition, not a Mag7 constant. The first signature is an all-keep `sellVaultTx` (`keep_tokens` is every allocated mint). `keep_tokens: []` is refused: it encodes no USDC buy target, so the native sale list stays empty.

After the burn lands, the same route returns an owner-signed claim. The owner pays for their token accounts. No keeper wallet subsidizes the exit. A later call with the claim signature sells only the positive owner deltas from that transaction. Each DB-leg mint is sold with Jupiter Swap v2 Router `GET /swap/v2/build` (`x-api-key: JUPITER_API_KEY`), raw instructions, ExactIn, destination the owner USDC account. `/order` transactions are not used.

## Residual stocks

A name Jupiter cannot build, a mint that is not a DB leg, or a quote that does not match the claimed amount is a residual. It stays in the owner wallet as stock, next to any USDC that did sell or that was already cash in the basket. That is not a share refund and not a keeper side-pay. The screen says so before signing, keeps a loader while the steps run, and shows USDC received only after the wallet balance moves. It does not say the proceeds were sent before that delta exists.

Atomic burn+claim+N sells is not required. Seven direct routes already overflow a naive packet; arbitrary N will not fit. Staged burn, claim, then per-leg sells is the path this route releases.
