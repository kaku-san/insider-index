# Composition 6020: existing-vault repair and hackathon boundary

## Recommended go-live path

Ship the research/index-discovery experience and keep public Invest/deposits/exit disabled. The existing Mag7 vault has a private, separately authorized native-cycle implementation, but it is not activated or a live-roundtrip claim; see the [private-cycle runbook](private-native-cycle.md). Configuration verification and offline evidence are not financial readiness, and do not replace exit guarantees.

No production configuration, journal, definition, transaction or funds were changed to develop this repair. Tests use unsigned, offline simulations. The operator steps below require separate signing/broadcast authorization; they are not authorization themselves.

## Receipt-bound identity (do not recreate)

[Finalized create receipt](https://solscan.io/tx/4uVycpbdmLWJR5ADkTYcoejkFGDThdTw9PAnw3UNcPMVU2QrmqdhLjbrXUuLEKJ5W4w4h2P7ZHaxYLQoA3CfPyBm), slot **447807594**, 2026-09-17T13:33:30Z, succeeded. It created Mag7 Caucus (`IITMAGCA`), not the fixed Kaku San basket. It did not install stock composition, set stock weights, deposit funds or mint investor shares.

- Index: `idx-theme-mag7-caucus`, saved definition version 2.
- Vault: `AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`
- Share mint: `9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4`
- Deployer: `H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph`
- Targets (bps): MSFT **3448**, AAPL **2740**, AMZN **1151**, GOOGL **1424**, NVDA **854**, META **322**, TSLA **61**. Total **10000**. No SOL allocation, reweighting, new share mint, receipt wrapper or replacement vault.

## What is repaired

1. Native `6020` is `InvalidOracleWeight`: an inactive edit still needs valid oracle settings. Defaults receive one real Raydium oracle at 10000 bps and the existing stock-input aggregator parameters (1 / 50 / 200 / 1), not empty oracles/zero thresholds. Zero oracle-count and zero confidence settings separately reproduce 6025 and 6023.
2. The deployed native program force-activates WSOL, even when the wire input says `active:false`. The exception is **only** mainnet WSOL `So11111111111111111111111111111111111111112`, with **zero target weight and Raydium pricing**. USDC is inactive with zero target, also priced. Both are allocated support/cash slots, not catalog investment legs. Unknown extra mints, wrong pools, Pyth, positive support weights, active USDC and incorrect stock weights fail verification.
3. The SDK emits dependent create-intent and execute transactions. Independent simulations make the second fail with 3012 (`AccountNotInitialized`). `composition-transactions.ts` combines each immediate pair into one packet, removes only identical duplicate compute-budget instructions, and simulates the exact atomic message. Missing/delayed pairs, conflicting budgets and packets over 1232 bytes refuse; there is no unsafe split-send fallback.
4. Prepare verifies the simulated vault, lookup tables and completed/closed intent before releasing an unsigned message. Matching partial intents execute only after post-state verification. Different/stale/multiple intents are preserved with a recovery error, not cancelled or overwritten. **Immediate native intents are status 0 and may leave `activeManagements=0`**; recovery queries intent accounts rather than treating that counter as an absence proof. Weight intent seeds are random, so token-PDA-only recovery would be insufficient.
5. Chain observation replaces optimistic local progress. A pending step takes priority. Lost local receipts recover identity from the persisted definition; conflicts refuse rather than overwrite. Create refuses an already-created definition. Configuration prepare checks vault/mint/deployer and refuses nonzero share supply or nonzero accounted composition balances: this is initial installation, not an arbitrary funded-vault editor. The durable create journal and signatures remain intact.

Shared policy: `src/lib/index-vaults/native-defaults.ts`. Both the fixed Kaku San path and the persisted-definition path use it; both remain selectable. Native layout capacity remains **100 allocated slots**, including the two defaults (at most 98 distinct investment legs in this layout); nothing is truncated. Catalog membership, stock pool evidence, the $10k pool floor, index weights, fees and public release flags are unchanged.

### Support-pool evidence

Observed mainnet Raydium CLMM pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`, program `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, has WSOL/USDC mints with decimals 9/6. Its raw account is in the captured VM snapshot at slot 447813178. Default preparation checks owner, pair and decimals anew. WSOL quotes USDC; inactive USDC quotes WSOL. This is separate native support evidence, not a hand-added stock mint or an edited stock pool snapshot.

## Balance and full-cycle consequences — not just observer relaxation

- **Deposit:** the real SDK deposit draft still contributes USDC. The zap-in planner allocates exactly the seven stock weights; WSOL is not admitted as an investment leg. Native SOL transaction fees/bounty funding are separate from investment weights; their configured parameters are unchanged (atomic grouping reduces transaction count). Tests build the real SDK contribution draft, but **do not apply a deposit or prove share minting**.
- **Pricing/valuation:** native price-update plans include all nine allocated slots, including inactive USDC and active zero-target WSOL. Keeper pool bindings now include both. `nativeNav` values effective backing by actual amounts, not target weights, and refuses unreconciled accounting. A nonzero SOL amount cannot be discarded merely because its target is zero. Bounty, fees, pending claims and backing must be reconciled separately; unaccounted token-account donations are not proved away by zero composition amounts.
- **Keeper:** the shared native eligibility rule exempts the bounty mint from direct drift. It is therefore **not evidence of a WSOL residual sweep**. Both keeper preparation paths refuse nonzero accounted WSOL at zero target (including when an existing intent would otherwise request a price update), pending bounty/backing reconciliation and USDC-conversion proof. Present native support slots must have the expected oracle/active policy and zero targets. No force-rebalance, threshold reduction or replacement eligibility math was added.
- **Exit:** `completeKeepTokens` retains every allocated mint, so WSOL cannot disappear from claim attribution. The generic native withdrawal builder still preserves in-kind claims and is not the public cash-out rail. The narrow Mag7 route instead prepares a simulated empty-keep auction; its keeper sells vault-held assets to USDC before settlement. The documented dust attempt remains blocked by a native intent constraint; this is not a full-cycle or losslessness proof. See the [Mag7 cash-out attempt](mag7-usdc-exit-attempt.md) and the [native vault owner contract](../src/lib/index-vaults/README.md).
- **Release:** `VAULT_RELEASE.publicFundsEnabled` is true, while `publicInvestSign` and `nativeUsdcExitVerified` remain false. DB coverage eligibility and the native `depositsAreAllowed` bit were already true for this vault; neither alone means the application accepts funds. The deposit and narrow Mag7 cash-out routes still enforce their own persisted-definition, identity, simulation and UI eligibility gates. External native-program access is not governed by the application's release flag.

If later proof requires a positive SOL investment allocation, new economics/security exceptions, or giving users a non-USDC exit bag, stop for a product/security decision. Do not silently expand this support-slot exception.

## Operator resume, only after separate authorization

1. Deploy the reviewed repair without migrations, deposit-flag changes or journal edits. Independently re-read program deployment, vault identity, share supply, accounted and actual balances, pending intents, saved definition and pool evidence. The September 17 capture is historical, not a fresh mainnet attestation.
2. In the hidden `/kaku-admin` **persisted index** path select `idx-theme-mag7-caucus`. Check the exact vault/share above. Do not select the fixed Kaku San basket for this vault. The UI restores a missing local receipt from the definition; a conflicting receipt must be inspected, not deleted.
3. Connect the approved deployer Phantom. Use **Resume composition install**, not a replacement create or discard. Starting from the captured state there are ten atomic configuration steps: two default conversions, seven stock additions, then exact target weights. Only the operator signs; no server keypair. Each prepare simulates the exact message and checks native post-state. A historical matching open intent is executed rather than reopened.
4. After a timeout/lost response, retain the receipt and re-observe. Retry is bound to the existing identity. `RECOVERY_REQUIRED` means inspect pending task/definition differences; never clear an intent or lease blindly. Oversized/delayed edits need a separate supported recovery design, not split broadcasting.
5. Final configuration readback must show exactly seven active stocks at the saved targets, WSOL active/0 bps, USDC inactive/0 bps, nine correctly bound Raydium slots, no Pyth and no pending configuration. Save real signatures and finalized readback. **This task has not performed these operator steps.**
6. Keep public deposits off. Separately authorize and prove USDC deposit → correct shares → dedicated-keeper rebalance → USDC-only redemption/conversion, including nonzero residuals, interrupted/retried claims, fee/bounty accounting and token-extension handling. The existing keeper CLI's `--dry-run` writes its observation to Supabase; it was **not** run against production here.

## Reproducible offline validation

`npm run typecheck && npm test`

`tests/composition-resume.test.mts` uses LiteSVM 1.4.1 and the captured **real deployed binaries** through actual SDK/app prepare and observe functions. It reproduces 6020/6025/6023/3012, native WSOL force-activation, ten-step convergence, matching partial token and random-seed weight intent recovery, stale-intent refusal, missing post-state refusal and negative composition mutations. Separate synthetic residual cases test accounting/keeper/exit behavior; they are not fabricated on-chain receipts. `tests/kaku-san.test.mts` also exercises the shared default prepare through the native VM.

Fixture provenance and limits: [tests/fixtures/composition/README.md](../tests/fixtures/composition/README.md). No live RPC, production writes, signing, broadcasts, browser, headless tools or DOM dumps are needed. Browser wallet interaction and a funded roundtrip remain **untested**, because this task has no authorization for them; neither is required to label the code-level tests honestly.
