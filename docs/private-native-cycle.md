# Private native USDC cycle — operator runbook

**Implementation is not activation. No live roundtrip is claimed. Public funds/Invest Sign/public exit remain off.** This private path lives only under `/kaku-admin`, `POST /api/vaults/cycle`, and the external `keeper:cycle` CLI. It does not replace either existing create-admin path, deploy a vault, or change native economics.

## What is proved / not proved

`tests/cycle-prepare.test.mts` drives authenticated owner API calls, independent wallet instruction/history/backing checks, the keeper tick, durable actual-SQL journal, and real native/CLMM programs in an offline VM. The seven-stock example contributes `100000000` USDC raw, receives `99` **raw native share units**, and recovers `99513128` USDC raw while preserving unrelated owner/keeper inventory. Local owner/keeper lamport debits are `11498118` / `13938800`; these are fixture diagnostics, not pilot budgets or fee promises. The fixtures combine capture slots; finality/order/expiry headers are synthetic. Separate tests cover restart, ambiguous relay, canonical expiry, cancellation and immutable credit accounting.

This is **not** evidence of current mainnet liquidity, live landing, a deployed migration, real wallet interaction or zero loss. No browser/Phantom interaction was run: project validation is code-level/offline only. Per-definition Pelosi/Gottheimer/Mag7/Silicon Hill regressions establish identity/prerequisite isolation, not four live or full-program cycles.

Native mint has no atomic minimum-share parameter; native fills have no atomic maximum-surplus-output cap. Client checks/simulation can refuse beforehand and flag observed violations afterward, but cannot undo permissionless/intervening native settlement. The aggregate USDC exit quote is not atomic across burn, claims and individual conversions. Issuer pause/freeze/permanent-delegate actions and market deterioration can prevent completion. No exhaustive-edge-case or losslessness claim is made.

## Preserve the installed pilot

For `idx-theme-mag7-caucus`, retain vault `AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`, share mint `9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4`, and MSFT/AAPL/AMZN/GOOGL/NVDA/META/TSLA targets `3448/2740/1151/1424/854/322/61` bps. WSOL stays active/zero target; USDC inactive/zero target. Raydium only, $10k pool floor, 25 bps host entry / zero host exit, xStocks preferred and verified Backpack fallback. No replacement vault or start-price repair.

Every operation loads its own persisted definition; nothing falls back to Mag7. Uncreated, partial-coverage, changed-definition and unsupported pool shapes refuse. Only proved CLMM routes are admitted; do not drop/renormalize unavailable constituents.

## Required approvals before any funding/signing

Record an explicit approval reference, owner and dedicated keeper identities, operation UUID, expiry and finalized `notBeforeSlot` anchor. Approve **every** `CyclePolicy` limit (`cycle-policy-parse.ts`): USDC contribution, minimum net raw shares and recovered USDC; cumulative owner/keeper SOL debit, priority fee, compute, bounty funding, rounding/dilution and keeper-surplus caps; quote lifetime, swap/native slippage and settlement drift. Fixture numbers are not approvals or recommendations.

Separately accept the exact current native fee-schedule hash, native filler-retained surplus, native share quantization, retained residual cash backing, issuer authority risk, and permissionless/native settlement enforceability limits. Residual cash is backing, not a promised refund; fee accounting units are not automatically spendable USDC. Approve keeper custody, funding and unattended signing authority; do not use the deployer, host or strategy wallet as keeper.

Production changes, migration application, deployment and public release require their own authority. A successful dry run does not grant it.

## Operator setup (only after approval)

1. Apply `supabase/migrations/202609200001_insiderindex_cycle_operations.sql` through the authorized DB process. Require shared service-role Supabase; no local file/in-memory fallback. Preserve the existing definition/deposit/create migrations. Test read/write/lease recovery before inviting funds.
2. Read the authoritative `insiderindex_vault_definitions` row. Confirm vault/mint, complete pool coverage, exact composition, per-vault deposit gate, designated separate keeper and automation authorization. `cycleDefinitionHash(record)` derives the policy binding; `observeCycle(...).feeScheduleHash` derives the current native fee binding. Do not hand-invent either hash or pool. Freeze definition/economic changes until this operation is terminal; a changed hash requires operator recovery review, not journal rewriting.
3. Create a private policy JSON matching `parseCyclePolicy` in `cycle-config.ts`. No fields default to approval. `notBeforeSlot` must be positive and come from the finalized chain before the first operation transaction. All money uses canonical base-10 raw strings, never floating dollar amounts. The same identity/economic limits must be used by app and operator CLI.
4. Configure server-only `STOCKLANA_CYCLE_POLICIES_JSON` as an array of explicitly approved policies and `STOCKLANA_CYCLE_AUTH_SECRET` as a random >=32-character access-challenge secret. Blank configuration makes the endpoint unavailable. The HMAC secret is **not a financial signing key**. Existing RPC and Supabase service-role configuration remain server-only.
5. Wallet validation reuses the existing server RPC through same-origin `/api/rpc`; no browser RPC URL/key or `NEXT_PUBLIC_SOLANA_RPC_URL` is required. `HELIUS_API_KEY` stays server-only. Phantom/Privy supplies signatures, not this page's read connection. The proxy supports the client's genesis/clock reads, vault-filtered native intent discovery, finalized address-signature pages (at most100, with a context-slot anchor), and signature-only finalized blocks, alongside existing account/transaction reads and simulation. Broad program scans, full-block downloads and unbounded/nonfinalized new history requests are refused. Instruction reconstruction, backing/credit accounting and simulations still run in the client; RPC accuracy/completeness remains a trust assumption, not a separate-provider guarantee. Pruned, missing, racing or over-limit history refuses signing. Both direct Raydium metadata endpoints must be reachable. No Pyth/Hermes configuration.
6. Keep the keeper's 64-byte JSON key outside the repository/app, on the authorized operator machine with owner-only file permissions (`0600`). Fund only the separately approved balances. Do not put that key in app env, Supabase, deployment files or logs.

Read/simulate only; no key is opened and no journal draft is written:

```sh
npm run keeper:cycle -- --policy /absolute/operator/approved-cycle.json
```

Execution template — **not permission to run it**. Requires explicit approval, `--execute`, the matching external key, live definition/automation eligibility, simulation and all policy gates:

```sh
npm run keeper:cycle -- --policy /absolute/operator/approved-cycle.json \
  --execute --keypair /absolute/operator/keeper.json --watch
```

Without `--watch`, one tick runs. The watcher signs keeper setup/prices/fills/mint/cleanup only, waits for owner actions and never withdraws for the owner. This is operation settlement, not a discretionary index rebalance/force-rebalance daemon. Exceptions in the configured operation stop the process; failures while ticking additional public Mag7 depositor operations are isolated so later operations continue. Investigate/restart the same operation, not a new UUID. No hosting/service provisioning is implied.

## Owner sequence

1. Connect the approved live owner wallet on `/kaku-admin`, enter the private operation UUID and review the exact policy. Sign the access-only message. Access expires after two minutes and may need renewal; it never grants token/delegate or transaction signing authority.
2. Let the separate keeper initialize its required ATAs first. Prepare the next owner step. Before a financial prompt, the browser reconstructs instructions from live native state and approved policy; verifies backing, canonical recipients, exact debits, fee schedule, minima, expiry and Token-2022 requirements; independently scans operation/ATA history; checks both route directions before contribution; and simulates the actual message.
3. Explicitly sign native generation creation, exact USDC contribution, then lock as separate owner steps. A simulation is not a completed deposit. Reconcile each finalized message before proceeding.
4. The external keeper performs native price updates and actual CLMM flash fills, then mint and cleanup. Wait through auction windows; no forced timing or preexisting keeper stock/USDC subsidy. Native supply, share recipients, fee accrual, canonical backing and all investor liabilities must reconcile before holding is reported.
5. Choose **Prepare USDC exit** separately. Review/sign the exact raw-share burn only after simulated native claims and after-fee/rounding liquidation quotes meet the approved minimum. Then prepare/sign/reconcile all claim batches, cleanup and exact-credit stock-to-USDC conversions. Only finalized native claim credits, minus independently observed disposals, can be sold. Purchases/donations/unrelated balances never replenish consumed credits.
6. `complete` requires finalized closure, no pending draft/native claim obligation, no unburned cycle shares, no unsold non-USDC credits, realized approved minimum USDC and no unresolved audit flag. Receipt totals are not wallet NAV; native token accounts remain ownership truth.

## Interrupted operations / refusal handling

- Keep the same index/vault/owner/operation identity. Exact signed bytes are committed before relay. After timeout, refresh/reconcile or retry **only those bytes**. Do not contribute/burn again or create a replacement generation.
- Even an unsigned issued draft is an obligation: a wallet may have broadcast outside the app. Wall-clock expiry, a null transaction or missing acknowledgement does not prove nonexecution. The runner scans consecutive finalized canonical blocks from the recorded root through blockhash expiry, at most two produced blocks per reconcile call. Repeated calls may be needed. Missing/pruned/gapped history preserves the obligation; an archive-capable RPC may be required.
- Access renewal/deadline-reference renewal or shutting off `financialExecutionAuthorized` preserves the journal hash. It does not authorize new spending. Owner cancellation/claim/recovery remains separate from keeper automation and per-vault deposit shutdown, but financial owner steps still require explicit valid authority.
- An abandoned journal lease never times out or gets stolen. After proving the old worker stopped and examining all pending signatures, an authorized service-role operator may call `recover_insiderindex_cycle_lock(operation_id, expected_token)`. This releases only the exact lease; it does not erase a draft, credit, receipt or money obligation. Never clear state by hand.
- Deficits, active vault-wide rebalance, unknown positive support/backing, changed identity/economics, external credit disposal, insufficient liquidity/minimum or a successful-but-out-of-bounds native result require reconciliation/audit. Do not lower a limit, sell unrelated assets, discard a pending message or relabel an in-kind remainder as USDC completion. This implementation does not promise automatic recovery from every external/native intervention.

## Submission / release checklist

- `npm run typecheck && npm test`; optional production bundle check `npm run build`, no browser/headless validation.
- Green authorized Luna-only no-mistakes PR; no default-branch push or merge.
- Report offline/program/real-finality evidence separately. Do not present test keys, fixture budgets or test outputs as operator approvals/mainnet receipts.
- Before any activation: separately approve all amounts/economics/custody, apply/verify shared storage and deployment, run current read-only prerequisites, prove authorized exit/recovery, and retain the real finalized receipts. Public release remains a separate gate.
