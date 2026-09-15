# Existing devnet vault: one no-send keeper tick

```sh
npm run keeper:devnet -- --dry-run
```

Runs the vault-native keeper observer and strategy decision service once against
`Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8`. It uses only the fixed public
**devnet** RPC and checks genesis before vault/balance reads. There is no mainnet,
RPC override, wallet/keyfile, execute, force-rebalance, new-vault or looping option.
Omitting `--dry-run` has identical no-send behavior. Unknown arguments fail before
networking. JSON is printed to stdout; process failures exit nonzero.

The CLI deliberately does **not** build or simulate transactions: SDK price
builders can involve multi-stage oracle updates and outside feed services. A
policy decision or SDK eligibility hint is not signer authorization or evidence
that those stages fit a SOL budget. No keeper key is loaded, no transaction is
signed/sent and no airdrop is requested. The tick's spend cap is zero.

## Composition and scope

- `workers/stocklana-keeper.ts` owns native observations and prioritizes existing
  intents over a new normal rebalance. It reports intent address/owner/type/action,
  raw bounty remaining, native mint supply and the settings/composition/fee hash.
  Normal eligibility is not even queried when existing intents need reconciliation.
- `workers/devnet-keeper-tick.ts` supplies the one historical test identity and
  composes that observer with `workers/strategy-service.ts`. This explicit test
  observation scope does **not** register or publish an execution-approved index,
  install strategy weights, impersonate an FMP book or enable public funds.
- There is no published execution envelope for the test basket. The CLI reports
  strategy `WAIT` and preserves native targets rather than inventing one. Library
  callers can evaluate an execution-test envelope with the existing policy
  evaluator; even `SUBMIT_WEIGHT_INTENT` is only a hypothetical plan and always
  returns zero transactions and `signerAuthorization: false`. It is not a native
  target/readiness attestation. The CLI does not accept an envelope or sign it.
- An existing intent or changed configuration prevents a new strategy submission.
  Configuration drift stays latched across subsequent ticks; no automatic baseline
  acceptance or reattestation is installed.

The private journal `.data/index-vaults/devnet-keeper-tick.json` holds the latest
100 observations under an exclusive single-host lease. Concurrent ticks fail
closed. A crashed lock requires deliberate operator recovery, not timeout-based
lock stealing. Read failure does not append a successful observation. This local
journal is diagnostic history, never an ownership or transaction ledger; do not
use it for distributed/serverless execution.

## Actual dry-run evidence

[`evidence/vaults/devnet-keeper-dry-run.json`](../evidence/vaults/devnet-keeper-dry-run.json)
records a real read-only run. At that observation:

- Pending deposit intent: `8YE4XGm767rVxFhEYr8snLDxgRf1G9YLCPwPBKD3QBCL`.
- Native action: **`update_prices`**; native bounty left: **890000 raw WSOL**.
- Native share supply: **0**; keeper decision: **RECONCILE_EXISTING_INTENTS**.
- Creator wallet balance: **4.807493578 SOL**, at the balance slot in the artifact.
- Strategy: **WAIT**, no published execution envelope. Broadcasts and spend: **0**.
- Transaction simulation: **NOT_RUN**; settlement: **NOT_CERTIFIED**.

Reads use confirmed commitment and are sequential, not a single atomic snapshot.
The balance slot refers to the balance read, not all vault/config/intent accounts.
The observed wallet balance is **not** a new funding authorization or a proven
remaining test-spend allowance. No fresh exact transaction cost was established;
`estimatedExecutionCostLamportsRaw` remains null. Historical funded contribution
and lock receipts remain in [the original test-vault report](../evidence/vaults/DEVNET_TEST_VAULT.md).
Nothing here repeats initialization/contribution or certifies minted shares.

## Before a future spending tick

Re-read this same intent and vault; verify oracle accounts/feed readiness, native
stage eligibility, program/config trust, exact instructions and fee/rent/bounty
costs. Obtain separate bounded scoped signer authorization and independently
confirm the remaining original test budget covers those costs. Simulate and
reconcile each authorized native stage before proceeding; never force a fund
rebalance or repeat a deposit to work around pending settlement. Those execution
and signer capabilities are intentionally absent from this command.

Behavioral tests: `node --experimental-strip-types --test tests/devnet-keeper.test.mts`
cover intent priority, normal/retired hints, no-envelope wait, plan versus signer
separation, persistent config drift, devnet/genesis/vault/balance failures,
concurrent leases, RPC failure recovery and rejected CLI overrides.

Local validation: **116 repository tests passed**, `npm run typecheck` and
`npm run build` passed; ESLint passed on all changed worker/script/test files.
Stale worktree route types were regenerated with `next typegen` before typecheck.
These checks and the dry-run do not prove native settlement or a funded roundtrip.
