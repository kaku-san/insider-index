# Native index vault integration — read-only delivery

The September 14, 2026 revision-3 contract handoff selects **one existing Symmetry V3 vault and one native share mint per index**. This implementation does not deploy a program, mint a wrapper, custody assets in a service wallet, or maintain an ownership ledger. Investor actions require their own authorization; holders never sign native fund rebalances. Creation and naming belong only to the deployer.

## Current release boundary

The initial integration was read-only. A separately authorized devnet-only test created one vault; its initial 0.1-USDC attempt stopped before broadcasting because the wallet had no SDK-USDC. See [historical receipt and addresses](../../../evidence/vaults/DEVNET_TEST_VAULT.md). The person/index Invest rail now reads this same test vault through a [devnet-only preview and gated signature seam](devnet-invest.md); it is never mapped to politician holdings. Preparation returns `503`/`wait` with no transactions because native readiness is still missing. No broadcast route exists. The separately managed funded-deposit attempt is not performed or certified by this UI integration. Public funds, native-USDC exit, optional wallet conversion, automatic signing and native recovery actions remain disabled. There is no environment variable that silently enables them. The native seed/deposit/share-transfer/redemption/fee roundtrip is **NOT_RUN**, not PASS. This is integration infrastructure, not a launch-ready or audited vault.

Legacy `/api/indexes/quote` and `/api/indexes/execute` return `503` without payloads/signatures. The old `STUBIDX`/in-memory index position writer is removed. Index pages display model allocations separately from unavailable actual native holdings. Existing single-trade Jupiter execution and full disclosed books remain separate and intact.

## Modules

- `adapter-contract.ts`: application boundary from the handoff, not a native IDL.
- `devnet-contract.ts` / `devnet-deposit.ts`: fixed existing test-vault identity, exact USDC input, read-only native preview and explicit preparation blockers; `devnet-invest.md` owns the Invest rail's devnet-only contract.
- `devnet-positions.ts` / `positions-contract.ts`: `/api/positions?wallet=…` observes only the existing devnet test vault via native owner token accounts; exact share units, slot/time, pending-intent marker, null NAV/value. `/positions` requires a live connected wallet, hides stale balances on refresh failure, and never counts Jupiter receipts. Read-only public chain data requires no signing; malformed selectors fail 400 and unavailable reads fail 503, not zero. `tests/devnet-positions.test.mts` executes binary account decoding and failure paths.
- `symmetry-adapter.ts`: pinned real SDK builders/readers; raw BN state, native share balances across owner token accounts, complete keep-token set (including inactive/residual slots), fee claims, weights/config/LUT tasks, native `isRebalanceRequired`. `SymmetryVaultAdapter` fails closed rather than return unverified investor payloads or fabricated settlement.
- `amounts.ts`: canonical u64 strings; SDK raw-number boundary rejects above `2^53-1`; integer bps validation and canonical hashes.
- `registry.ts` / `deployer.ts`: domain-separated Ed25519 manifest authorization, metadata byte hashes, separate roles, generation/address conflicts and retained retired exits. Locally prepared create addresses are not registered as actual vault identities. Creation retries reuse the saved draft; no execution path is provided.
- `readiness.ts`: exact mint/network/program/decimals/oracle/basis, extensions, bidirectional intended-size route evidence, deposit and second-wallet claim transfer evidence. Missing evidence stays UNTESTED. Catalog membership is not native readiness.
- `operations.ts` / `journal.ts`: UUID/idempotency, owner+vault conflict gates, generation binding to creation signature+slot, pending attempts/message hashes, finalized observation journal. No database row confers ownership.
- `transaction-policy.ts`: decode actual serialized messages with ALT resolution; check exact independently reviewed instructions, signers, writable accounts, programs, debit ceilings, recipients, per-transaction minima and compute budgets; explicitly call RPC `simulateTransaction`. No generic native/Jupiter instruction decoder is enabled. Unsupported semantics fail closed. Simulation does not prove contract security or asynchronous minima.
- `exit-conversion.ts`: pure exact-credit attribution, aggregate per-mint wallet caps and replay guards. Optional user-wallet Jupiter sales remain disabled pending native receipt and route decoding fixtures; never sell the whole wallet or use a keeper delegate.
- `nav.ts` / `fees.ts`: native effective-accounting inputs only, integer/rational base-versus-scaled valuation once, separate USD/USDC, stale values unavailable, zero-supply bootstrap unpriced; host entry **25 bps**, host exit **0**, other host/creator/manager/vault fees zero. Accrual is not presumed spendable SPL shares/USDC; protocol fee shares are not flat deposit fees.
- `workers/strategy-service.ts`: complete published composition/policy/admission/replay/turnover/delay gates. A SUBMIT decision is a **plan**, not signer authorization. No root/metadata/fee/force access is provided.
- `workers/stocklana-keeper.ts`: registered-only read-only tick with a persistent exclusive lease and config change monitoring; no unfiltered protocol monitor or sender. Native eligibility is a hint until current native state/fixture checks pass.
- `workers/chain-reconciler.ts`: bind finalized wire-message hash to expected attempt; requires a trusted, versioned native effect decoder before applying observations. No such decoder is installed yet; finality/HTTP success alone never creates shares or clears claims.

### Storage/recovery limits

Journals are private atomic JSON snapshots on **one durable local host**, fsynced and serialized by an exclusive directory lock. Place them under `.data/index-vaults/` (already ignored and outside the web root). They persist workflow observations, never signed spending payloads or secret bytes. Concurrent writers fail closed; a crashed `.lock` is **RECOVERY_REQUIRED**, not an automatically stolen lease. Inspect processes and prior signatures/state before deliberate lock recovery. No broadcast route exists while this recovery is manual.

Before distributed/unattended execution, replace the local journal with transactional shared storage, uniqueness constraints and fenced leases. Do not deploy these journals on ephemeral/serverless disks. Native state remains authoritative. Readiness/config changes invalidate preparation, not ownership. Old generations and outstanding claims must remain discoverable.

## SDK/source inspection

Pinned runtime dependencies: `@symmetry-hq/sdk@1.0.22`, `@solana/web3.js@1.98.4`, `@solana/spl-token@0.4.14`; exact npm integrity is in `package-lock.json` and `evidence/vaults/sdk-report.json`.

The SDK package identifies itself as **Symmetry V3** and is BUSL-1.1, with an Additional Use Grant explicitly permitting commercial Symmetry integration, not competing protocol/SDK infrastructure. No closed program source or SDK code is vendored. It ships typed binary layouts, **no standalone Anchor IDL JSON**. We record types/layout hashes, never relabel one as an IDL hash. This does not attest deployed binary/source correspondence.

Observed distributed-SDK details:

- Program constant (both networks): `BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate`.
- Devnet SDK USDC is `USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT`, not an assumed mainnet mint; no stock-route compatibility is inferred.
- `buyVaultTx` implementation emits **create + contribution** batches; its comment describes a lock batch which is commented out in this distribution. Use separate `lockDepositsTx` after confirmed creation/contribution, never assume the comment proves lock.
- Amount fields are raw integer **numbers**, not display units. SDK internals also convert some native counters/bounty balances with `parseInt`; large internal amounts need independent policy validation before any wallet release.
- `createVaultTx` derives addresses from the current native vault counter; persist returned vault and mint separately. Global-counter races and uncertain create receipts require reconciliation, not generation of a second vault.
- Start-price builder parses a float then divides by `10^6`. The USD/USDC quote basis and bootstrap fairness remain unverified; **not enabled by a display label**.
- `sellVaultTx` has `keep_tokens`, no documented output-mint or aggregate minimum-USDC argument. Keep all allocated slots for baseline redemption; reconcile residuals and correct-program recipient ATAs before enabling claims.
- `signAndSend*`/SDK `simulateTransactions` helpers can send. Read-only connection middleware rejects non-read RPC methods, including send/airdrop. The scripts never load a signer.

`npm audit` currently reports transitive advisories (including bigint-buffer, axios, ws). The pinned SDK/SPL tree has no nonbreaking fix for every advisory; funds remain disabled. No blind audit-force downgrade or silent SDK upgrade was made. Review these before financial release.

## Read-only evidence and commands

```sh
npm run typecheck
npm test
npm run build
node --experimental-strip-types scripts/deployer-vaults.ts --help
node --experimental-strip-types scripts/verify-index-readiness.ts devnet https://api.devnet.solana.com
```

`evidence/vaults/devnet-readonly.json` records the actual devnet finalized program/config observations, program-data hash and upgrade authority. It proves only what was read at that slot. No per-mint price/feed/route/transfer probes or securities basket were certified. The deployer CLI accepts a signed local bundle, validates metadata bytes without fetching arbitrary URLs, and intentionally waits for readiness. It has no `--execute` switch. Unknown/unconfigured input never fabricates a Pelosi basket.

The handoff's 77 Python reference tests passed locally using its reference package on `PYTHONPATH`; these are arithmetic/planner tests, not native tests. Repository tests execute the public policies, journal restart/replay, signature verification, native keep set, NAV, disabled API responses, and actual wire-message simulation with deterministic RPC fixtures. No app fixture claims to prove native security.

## Parallel FMP handoff

`composition.ts` consumes a **published ModelComposition execution envelope** with immutable source, manifest and policy hashes. `consumePublishedComposition` rejects partial/stale/unpublished input and names execution-test data `Execution Test — not politician holdings` under an `execution-test-*` identity. The FMP store is implemented on Track A; this branch does not change its raw extraction or use the legacy PTR-netted calculator. Until that store publishes a compatible envelope, callers inject labelled test models; no real FMP portfolio or active strategy is asserted. No stock mints are hand-added.

## Required follow-up before enabling any funds

1. Independently verify deployment/config/version/role trust and every admitted mint/oracle/extension/transfer/route at the intended size. Bound and authorize network, signer paths, setup costs, seed and test budget **separately**.
2. Complete native instruction/effect decoders and approved policies (including CPI destinations, actual deltas, native accounting buckets and minima), correct-program recipient ATA preparation, program/config reattestation and exact setup budget accounting.
3. Read back deployer/host/name/hash/share mint, installed oracles/weights, all native fees, disabled dangerous authorities and delayed scoped management roles. Verify startup deposit window; implement activation/resume and migrations without hiding old claims.
4. Execute authorized seed → second-wallet deposit → native mint **and unused returns** → fee accrual/claim → share transfer → all-assets redemption, including inactive assets. Record real signatures/slots/deltas/costs. Deliberately fail a claim then restart and recover without another burn/deposit.
5. Implement/test persistent claim/fee reconciliation and stage-specific cancellation, bounded normal keeper execution and delayed strategy activation, without holders signing rebalances or force-mode fallback. Test actual native AND thresholds, cooldown/window/bounty, concurrent keeper races and post-send timeouts.
6. Integrate published FMP models, share-mint position and operation auth APIs (wallet nonce/session/CSRF/rate limits), actual net-of-fee NAV history and claim-resume UX. Only then consider optional exact-credit user-authorized USDC conversion. Native guaranteed-USDC exit stays OFF absent separate proof.

The integration itself confers no funding authorization. The separate devnet creation receipt is not a successful funded deposit roundtrip, production deployment or public-funds approval.
