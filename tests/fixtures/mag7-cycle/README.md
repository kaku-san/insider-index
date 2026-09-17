# Mag7 execution-segment fixtures (NOT a live roundtrip)

These are public read-only captures from the existing vault/share, not a replacement create. `MANIFEST.json` binds every uncompressed capture/binary; the helper checks every loaded file. No secret material or signed transactions.

- `current-accounts.json.gz`: finalized mainnet slot **447849522**, 78 accounts, captured with `getMultipleAccounts` on 2026-09-17. Includes the installed nine-slot Mag7 vault and actual six-decimal share mint; unlike the composition fixture, mint/burn tests use the real raw mint account and observe its mutated local supply.
- `jup-ledger-quote.json.gz` / `jup-ledger-build.json.gz`: keyless Jupiter **v1** quote and unsigned swap-instructions responses. One direct Raydium CLMM USDC→TSLA route through the already bound TSLA pool. `useTokenLedger:true`, `useSharedAccounts:false`, no wrap/unwrap. This is not the app's v2 whole-order execution API. The fixed diagnostic quote input (610000 raw USDC) is not a minimum pilot recommendation.
- `jup-ledger-accounts.json.gz`: real route accounts/LUT at finalized slot **447851876**. Existing core accounts retain the earlier capture; only missing DEX accounts are added. This is explicitly a mixed-slot stateful execution fixture, **not a reconstructed historical bank** or live quote freshness proof.
- `jup-ledger-programs.json.gz` and the two `.so.gz` files: public deployed Jupiter V6 and Raydium CLMM binaries, ProgramData addresses and SHA-256 hashes. Native BASKT, ATA, Token and Token-2022 programs reuse the hash-checked [composition capture](../composition/README.md). This does not prove source/build equivalence or that a later upgrade is safe.

`tests/support/mag7-cycle-vm.mts` adds **synthetic local-only** 5-SOL payer balances and a 100-USDC deposit input. The native-accounting control separately supplies synthetic keeper stock inventory; it is never DEX/liquidity evidence. The real DEX test supplies **no inventory to satisfy the trade**: native flash credit funds an actual captured Raydium swap, with Jupiter's token ledger isolating it from unrelated test-keeper assets. Only signer/source/destination metas are rebound from the capture's public owner to the distinct test keeper. No network, keys, signature generation, send, airdrop, journal or DB call exists in the helper. `apply` is unsigned simulation plus copying post-accounts into the local VM.

Executable evidence: `node --experimental-strip-types --test tests/mag7-native-cycle.test.mts`.

The tests assert:

- native USDC contribution→lock→Raydium prices→seven inventory-funded native fills→mint→cleanup→burn→partial in-kind claim→resume, without a second burn;
- real DEX-backed **one-leg** TSLA IOC flash settlement; exact vault/intent credits and preserved unrelated keeper balances;
- existing bootstrap precision: 100 raw shares (0.000100 displayed), configured 25/0 host rates but zero raw fee shares at this test size; residual cash is backing, not an automatic refund;
- native auction surplus stays with the filler (318 TSLA raw units in this fixture). **No new policy authorizes keeping, sweeping or funding that surplus.**

These are native execution/accounting tests, not a funded release or finished pilot. Seven DEX-backed legs, real reverse conversion, attributable-credit sales, end-to-end limits/recovery and live approvals remain unproved. Public funds/Invest/USDC-exit flags remain off. No wallet UX is enabled by these fixtures.
