# Mag7 USDC cash-out attempt

**2026-09-22.** Read-only mainnet simulation for the reported holder
`8RZ4GrQDsctRGrW4tDZcYZRqFAW23eWkrVcJQ1DH7GyX`, Mag7 vault
`AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`, and share mint
`9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4` built the pinned
Symmetry `sellVaultTx` transaction for **3 raw shares** with `keep_tokens: []`.

The unsigned one-signer message was 900 bytes. Mainnet `simulateTransaction`
returned `CreateRebalanceIntentHandler` / Anchor `ConstraintRaw` (`0x7d3`) on
the rebalance-intent account. Nothing was signed or broadcast. The dust holder
therefore cannot start an auction until that on-chain intent constraint is
cleared/reconciled; it is not proof that a normal-sized withdrawal cannot settle.

`POST /api/indexes/idx-theme-mag7-caucus/withdraw/prepare` deliberately performs
the same simulation before returning a wallet message. It only releases the
empty-keep auction message when simulation succeeds, burns exactly the requested
shares, and declares the user as the eventual USDC recipient. The keeper settles
that vault auction; it never receives a delegate over user wallet tokens.
