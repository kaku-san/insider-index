# InsiderIndex full-flow / API / contract audit — 2026-09-15

This file is the implementation checklist for the consumer redesign. It reconciles the supplied **design handoff** with the separate **Final Contract Handoff**. It intentionally distinguishes what is wired in this frontend from what still requires the production server/native adapter.

## Product identity migration

Canonical product name: **InsiderIndex**. Canonical public URL: **InsiderIndex.xyz**. New browser-storage keys, preview globals, gateway headers and deployment env names use `insiderindex` / `INSIDERINDEX_*`. For a safe rollout, the gateway temporarily accepts the legacy `STOCKLANA_*` backend env names and `x-stocklana-wallet-proof` header and forwards both header variants upstream. This compatibility layer can be removed after production services migrate.

## Executive status

| Area | UI | Typed client | Backend in this recovered ZIP | Real funds status |
| --- | --- | --- | --- | --- |
| Browse people / portfolio / published model | Done | Done | Same-origin gateway present; upstream research API required | Read-only |
| Follow | Done | Existing/local contract | Same-origin gateway present; upstream persistence required outside preview | No funds |
| Copy one eligible disclosure | Done | `/api/quote` + `/api/execute` | Same-origin gateway present; upstream quote/execute service required | Fail closed without production API + wallet |
| Connect / wallet-scoped portfolio | Done | Privy React/Solana adapter + preview adapter | Production app ID/config required | Real external/email connect when configured; preview stays local |
| Native index readiness | Done | Done | Same-origin gateway present; native upstream adapter not present | Read-only until native backend exists |
| Native index deposit | Done, including separate deposit + lock approvals | Done | Gateway present; native prepare/reconcile implementation not present | Fail closed |
| Native index position | Done | Done | Gateway present; authoritative native position service not present | Read-only until backend exists |
| Native withdrawal | Done | Done | Gateway present; native redemption/claim implementation not present | Fail closed |
| Claim / partial claim / resume | Done | Done | Gateway present; chain reconciliation store/worker not present | Fail closed |
| Optional redeemed-token → USDC conversion | Done | Done | Gateway present; redeemed-credit conversion service not present | Fail closed |
| Operation resume / recovery UI | Done | Done | Gateway present; durable operation/recovery backend not present | Fail closed |
| Retired multi-leg basket stub | Safe tombstone only | No calls | N/A | **Never sign** |

The rework now includes `src/app/api/[...path]/route.ts`, a same-origin **fail-closed API gateway** for every non-catalog product route. It proxies research/copy requests to `INSIDERINDEX_API_BACKEND_URL` and native vault lifecycle requests to `INSIDERINDEX_NATIVE_BACKEND_URL` (falling back to the general backend). If no upstream is configured it returns an explicit 503; it never fabricates a financial success. The actual quote engine, persistence, native SDK adapter, reconciliation and keeper services still must exist upstream.

---


### Same-origin route coverage

`src/app/api/[...path]/route.ts` physically covers the browser-facing endpoint surface, including research, following, Track A, positions and Track B. The gateway forwards authorization / Privy identity headers and cookies to the configured trusted upstream, blocks self-proxy loops, disables caching, and returns explicit 502/503 failures when the upstream is unavailable. Authentication and wallet ownership must still be verified by the upstream before any prepare endpoint returns signable bytes.

## Consumer routes now covered

| Route | Purpose | Money behavior |
| --- | --- | --- |
| `/` | Discover people and published person-index research | none |
| `/p/[id]` | Compact person portfolio: identity + chart + holdings/moves tabs | opens native index flow only when a published index exists |
| `/indexes/fmp-[hash]` | Published target, exclusions, readiness | opens native vault deposit flow |
| `/feed` | disclosure tape | Copy only when disclosure is eligible |
| `/trade/[disclosureId]?copy=1` | one-leg copy ticket | Jupiter quote → user sign → execute |
| `/positions` | **My Portfolio** | keeps native index shares and copy receipts separate |
| `/positions/[indexId]` | share position detail | opens native exit flow |
| `/operations/[operationId]` | resume/reconcile operation | status/next/recovery boundary |
| `/following` | device/local watchlist | none |
| `/flow-lab` | end-to-end interactive design review | preview simulation only |

---

## Track A — copy one public disclosure

### Required endpoints

| Endpoint | Frontend status | Contract |
| --- | --- | --- |
| `GET /api/health` | product gate expected | live service / provider health |
| `GET /api/disclosures` | used by Feed | public disclosure rows + `tradeEligible` |
| `GET /api/disclosures/:id` | used by copy ticket | exact public print |
| `POST /api/quote` | wired | body: `mint`, `usdcAmount`, `side`, optional `taker` |
| `POST /api/execute` | wired | signed one-leg transaction → durable fill receipt |
| `GET /api/positions?wallet=…` | wired | copy fills; may additionally return chain share summaries |

### Guardrails

- A copy is **one disclosure / one market leg**, not a person index.
- Quote request uses `mint`, not the previously mismatched `outputMint` request field.
- Route mints are checked against the requested mint and canonical USDC mint before signing.
- Quote expiry and wallet/amount changes invalidate approval.
- User rejection / quote failure / execute failure stays on the ticket and creates no fake fill.

---

## Track B — native person index

### Frontend endpoint contract

All token/share amounts are raw decimal strings at the API boundary.

| Endpoint | Request / meaning | UI consumer |
| --- | --- | --- |
| `GET /api/indexes/:id/vault` | native identity, readiness, target/actual weights, fees, slot | index page, position page |
| `GET /api/indexes/:id/position?owner=…` | authoritative share balance, pending intents, claims | position detail |
| `POST /api/indexes/:id/deposit/prepare` | `owner`, `amountRaw`, `idempotencyKey`, wallet proof | entry flow |
| `POST /api/indexes/:id/withdraw/prepare` | `owner`, exact `shareAmountRaw`, `requestedExitMode`, idempotency | exit flow |
| `POST /api/operations/:id/receipts` | submitted user signatures | approval reconciliation |
| `GET /api/operations/:id` | observed chain-backed phase / claims / credits | progress + resume |
| `POST /api/operations/:id/next` | current safe next action, based on native state | progress flow |
| `POST /api/operations/:id/convert/prepare` | selected **credited-leg IDs only** | optional post-redemption USDC conversion |
| `POST /api/operations/:id/recovery/prepare` | tested native recovery/cancel/claim action only | recovery state |
| `POST /api/internal/indexes/:id/compositions` | policy-valid service candidate | backend/service only |
| `POST /api/internal/indexes/:id/rebalance/check` | normal native eligibility | keeper/worker only |

### Deposit lifecycle shown in UI

```text
DRAFT
→ AWAITING_SIGNATURE          investor reviews deposit payload
→ SUBMITTED
→ INTENT_CONFIRMED            native owner/vault intent exists
→ AWAITING_LOCK               separate user lock approval when required
→ PRICING                     keeper
→ AUCTION                     keeper/Jupiter native auction path
→ SETTLING
→ SHARES_RECEIVED             shares can arrive before cleanup finishes
→ RETURN_PENDING              unused contribution assets may remain
→ CLEANUP
→ COMPLETE
```

**Important:** the simulator no longer bundles deposit and lock as one pretend approval. Production `/next` must decide when lock is valid.

### Withdrawal lifecycle shown in UI

```text
DRAFT
→ AWAITING_SIGNATURE          exact share amount
→ SUBMITTED
→ REDEMPTION_CLAIM
→ CLAIM_PENDING               every composition token/account reconciled
→ TOKENS_RECEIVED
→ choose:
   A. COMPLETE_IN_KIND
   B. CONVERTING → PARTIAL_USDC | COMPLETE_USDC
```

If only some post-redemption sales succeed, the user owns the confirmed USDC **plus the remaining tokens**. There is no second share burn and no second withdrawal fee.

### Exact share sizing fix

The UI now converts entered share text → raw share amount using `shareDecimals` and integer arithmetic. A 25%/50% partial exit no longer accidentally sends the position's full raw share balance.

---

## Native SDK mapping from the supplied Final Contract Handoff

These method names are a build contract, **not evidence that the adapter exists in this ZIP**.

| Job | Native SDK builder/helper |
| --- | --- |
| Create instance | `createVaultTx` |
| Read vault / mark | `fetchVault`, `loadVaultPrice`, `fetchGlobalConfig` |
| Add token/oracle | `addOrEditTokenTx` |
| Set target weights | `updateWeightsTx` |
| Configure automation | `editAutomationTx` |
| Deposit USDC | `buyVaultTx` |
| Lock contribution | `lockDepositsTx` |
| Read native intents | `fetchVaultRebalanceIntents`, `fetchRebalanceIntent` |
| Update native prices | `updateTokenPricesTx` |
| Compute auction routes | `getSwapPairs` |
| Compose Jupiter instructions | `getJupTokenLedgerAndSwapInstructions` |
| Native auction fill | `flashSwapTx` |
| Mint index shares | `mintTx` |
| Burn/redeem shares | `sellVaultTx` |
| Claim underlying | `redeemTokensTx` |
| Normal rebalance | `isRebalanceRequired`, `rebalanceVaultTx` |
| Bounty | `addBountyTx`, `claimBountyTx` |
| Recovery/cancel | `cancelVaultIntentTx`, `cancelRebalanceIntentTx` where tested |

### Authority separation

- investor: contribution, lock, redemption, and any **user-wallet** post-redemption sales that require their authority;
- keeper: eligible native price/auction/mint/redeem/rebalance work;
- strategy service: policy-valid weight changes only;
- deployer: create/name/configure/fee/role authority;
- client: never authoritative for operation status or settlement.

---

## Exit correctness requirements

1. Read actual share balance/decimals.
2. Build a complete `keep_tokens` set from **all native composition slots including inactive/residual assets**.
3. Prepare every required recipient token account with the correct token program.
4. Build `sellVaultTx` for the exact raw share amount.
5. Confirm the irreversible share-burn/entitlement stage from chain evidence, not HTTP success.
6. Run/reconcile `redeemTokensTx`.
7. Keep `CLAIM_PENDING` until every outstanding user entitlement is discharged.
8. Only then allow cleanup/bounty closure.
9. Optional USDC conversion spends only `verified credited amount - already sold`, never the wallet's whole balance of that mint.
10. `COMPLETE_USDC` requires all attributed credits sold or an explicit tested dust policy; otherwise show `PARTIAL_USDC`.

`keep_tokens: [USDC]` is **not** assumed to mean “sell everything to USDC”. Native guaranteed-USDC exit stays disabled until proven by the pinned SDK/IDL and negative tests.

---

## Known devnet pilot identifiers from the design handoff

```text
Program:    BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate
Vault:      Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8
Share mint: Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A
SDK USDC:   USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT
Raydium:    5Eu2G2USTy1pqphmQzQ2SBXWrBq5sdhgEh7hso9R2xix
```

These identifiers are **not** enough to enable public funds. Readiness/capability evidence must still pass.

---

## Retired / prohibited path

```text
POST /api/indexes/quote
POST /api/indexes/execute
```

The old multi-leg basket implementation is retired. `src/components/index-ticket.tsx` is now a fail-closed tombstone and does not call either endpoint. An old response such as `{ kind: "stocklana-index-stub" }` must never be signed.

---

## What remains outside this recovered ZIP before real funds

1. Configure/test the included Privy adapter with the real app ID, connectors/RPCs and backend session/ownership verification.
2. Production research/copy APIs.
3. Native vault server adapter implementing the endpoint table above.
4. Pinned Symmetry SDK + exact IDL/types, capability attestation and negative tests.
5. Durable operation/receipt/claim storage (schema supplied in the Final Contract Handoff).
6. Wallet nonce ownership proof, auth/session/CSRF/rate-limit controls.
7. RPC simulation and server validation of every unsigned payload before it reaches the wallet.
8. Chain reconciliation for receipts; never trust client phase/status.
9. Keeper/strategy/deployer services and authority separation.
10. Round-trip devnet tests including failed claim, partial conversion, browser disconnect/resume and duplicate-intent prevention.

Until those are present, the redesigned frontend stays fail-closed outside explicit design-preview mode.
