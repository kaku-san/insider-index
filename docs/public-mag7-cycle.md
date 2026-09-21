# Retained public Mag7 cycle surface — not mounted on Invest

The public Mag7 cycle endpoint and `PublicCycleClient` remain retained compatibility infrastructure, but `VaultFlow` no longer mounts them for Invest. The Invest path is the release-gated `POST /api/indexes/:id/deposit/prepare` rail documented in [`src/lib/index-vaults/README.md`](../src/lib/index-vaults/README.md): the wallet signs SDK `buyVaultTx` contribution transactions and `lockDepositsTx`, then a keeper mints shares later. Other indexes are accepted only by the persisted-definition deposit route when their gates are open. No replacement vault, receipt token, server signer or wallet-side broadcast is introduced.

## API and authority

`POST /api/indexes/idx-theme-mag7-caucus/cycle`:

- `{ action: "discover", wallet, amountRaw? }`: derive a wallet operation from the **unique** configured Mag7 template, binding its definition hash to the live persisted Mag7 record rather than a historical environment hash. The keeper wallet is refused. `amountRaw` is positive raw USDC (six decimals), bounded only by exact SDK integer representation, not a product cap. Minimum shares and minimum USDC exit scale proportionally; slippage and cost budgets never widen. Omit the amount to resume the durable selected amount. A different amount or superseded definition restarts only a `new`/`investing` journal with zero contributed USDC, zero minted shares, no finalized contribute/mint receipt, and no unresolved draft; the definition hash, policy hash and approved amount update together under the journal lease. A contributed amount or any funding receipt is immutable. Returns an operation/owner/policy-hash binding and HMAC-bound access challenge.
- `{ action: "read" | "reconcile", operationId, auth }`: after the owner's access-message signature, return the bound policy, persisted definition and journal state. Read/reconciliation remains available when new deposits close. Access is not a financial signature.
- `{ action: "prepare", operationId, auth, request: "next" | "withdraw" | "recover" }`: use the **same** `CycleRunner`, native planner and shared Supabase journal as `/api/vaults/cycle`. The authenticated, selected exact contribution is the only permitted deposit amount. Withdrawal is the approved operation's full unburned native-share amount; arbitrary amounts, partial exits and in-kind completion are not offered by this bridge.
- `{ action: "submit", operationId, auth, request: "next" | "withdraw" | "recover", signedTransaction }`: independently validated owner-signed bytes only. The request preserves the deposit/withdrawal mode for action-specific failure copy; it does not select an arbitrary operation step. The shared runner commits the signature and exact bytes before audited relay. No signature-only receipt assertion can authorize a relay or create a balance.

Same-origin POST JSON, the existing 8 KiB request bound, exact fields, owner Ed25519 access proof, policy binding, scrubbed errors and private/no-store responses apply. Public error responses expose plain user-facing `error`/`message` text; the machine-readable lifecycle code is retained separately as `code`, and recovery instructions are never returned. Keeper actions and client financial authority are refused. The public surface does not expose the private unauthenticated `challenge` response; discovery returns only its binding.

The full policy must exist and contain the separately approved amounts, costs, economics and risk acceptance documented in [the private-cycle runbook](private-native-cycle.md). This bridge does not fill missing values from balances, quotes, fixtures or UI presets. Each depositor must sign their own access proof and financial transactions.

## Signing, settlement and recovery

`cycle-sign.ts` is the shared private/public owner-signing boundary. It invokes `validateCycleOwnerTransaction` against the same-origin `/api/rpc`: independent native state/backing, actual instruction reconstruction, finalized owner/intent/ATA history, recipients/debits/minima and simulation. The returned signed message and Ed25519 signature must match exactly. The wallet **signs only**; `signAndSendTransaction` is not used for Mag7.

The public client retains exact bytes across ambiguous HTTP replies and wallet changes. Another signature for the same draft is refused. A server summary that changes `pending` does not itself retire retained bytes: the client checks the exact finalized receipt, or bounded continuous finalized block/signature evidence past the known wire's validity, before a later independently validated signature. This retained-wire check does not replace the journal's full-message canonical expiry proof or the next step's full history audit. Missing/pruned/gapped history fails closed. An unsigned draft also is not discarded merely to change an amount; reconciliation must record canonical expiry first, after which the empty journal can restart.

The dedicated keeper still runs **outside the app** under its separately approved policy and key-file authority. Discovery, wallet connection and an automation configuration bit do not start it. No keeper key is loaded by a route. Claim and conversion steps remain explicit owner approvals; unrelated inventory cannot replenish attributable credits. Receipt totals shown in the controls are **not balances/NAV**; native SPL share accounts determine ownership. The cash-out controls continue through claim → cleanup → conversion until realized USDC meets the policy minimum; an in-kind claim is not completion. Public transfer-holder onboarding/general redemption remains outside this journal-based bridge.

`/indexes/idx-theme-mag7-caucus?nativeCycle=resume` opens the same public controls even when new deposits are closed. Renew access, read/reconcile, and continue the existing operation; never replace ambiguous funding or burn. Financial recovery still needs a valid approved policy—closing deposits is not permission to invent recovery budgets. Position reads are wallet-scoped through the `?wallet=` query contract; `?owner=` is not accepted. The existing private operator surface and external keeper remain available unchanged.

## Release and evidence

This amount/exit change does not modify `VAULT_RELEASE` gates. The project full-cycle receipt requirement is unchanged. Public availability requires the release gates, original created Mag7 identity, its per-vault deposit gate and an active unambiguous configured policy. Directory and detail responses scope public eligibility per index, so a future global release cannot make uncreated or other indexes appear depositable. Server execution also checks release at preparation and again before relay; a shutdown retains a received signature but refuses new funding. Approved exit/claim/cancel/conversion are not disabled merely by closing new deposits.

`tests/public-cycle.test.mts` drives a non-template depositor choosing $100 against a $200 template through the actual public client, authenticated handler, real SQL migration, native program fixtures, independent wallet validator and separate keeper through contribution → shares → attributable-credit USDC exit. `tests/public-cycle-amount.test.mts` checks exact amount parsing, proportional minima, immutable resume, HMAC tampering and cash-out continuation. It also checks missing configuration, wrong scope/owner/origin, injected budgets/keeper authority, unsafe sub-share amounts, global/per-index eligibility, a closed release, ambiguous replies and wallet changes. `tests/public-cycle-wire.test.mts` exercises retained-wire expiry through real web3 HTTP serialization with mocked RPC responses.

These are **offline, mixed-slot fixture executions with synthetic finality**, not live financial receipts or a losslessness guarantee. No real wallet, funded public cycle, browser/DOM or Production write is validated by them. Actual public activation still needs approved configuration and the required live release evidence.

## Emergency operator SQL

Only if an immediate unblock is necessary, an operator may delete an **unlocked, entirely empty** Mag7 row for one wallet. Replace `:wallet` with the exact base58 owner and review the `returning` result before committing; this query refuses all drafts, receipts, credits, funding, shares, and non-`new` state.

```sql
begin;
delete from public.insiderindex_cycle_operations
where index_id = 'idx-theme-mag7-caucus'
  and owner = :wallet
  and complete = false
  and lock_token is null
  and state->>'phase' = 'new'
  and state->>'contributedUsdcRaw' = '0'
  and state->>'mintedSharesRaw' = '0'
  and state->'pending' = 'null'::jsonb
  and state->'receipts' = '[]'::jsonb
  and state->'credits' = '[]'::jsonb
  and state->'expiredDrafts' = '[]'::jsonb
returning operation_id, owner, updated_at;
-- Commit only after the returned row is the intended empty journal.
commit;
```

Frontend tabs, general copy and layout are separate from this retained lifecycle implementation. The Invest modal does not consume `PublicCycleClient`; UI work for deposits should follow the persisted-definition prepare route and its sequential wallet confirmations. Keep this document for callers of the retained cycle endpoint, and do not re-mount it on Invest without an explicit contract change.
