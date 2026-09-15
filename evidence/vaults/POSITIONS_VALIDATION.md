# Devnet share positions validation

Composed `fm/stocklana-vault-wire-f1` at `922242d07d625d7eacc2e45bf5651a7c5e9054a1` (includes vault-native) without creating another vault.

`/positions` and `GET /api/positions?wallet=…` now read the existing test vault's native owner token accounts. Raw share amounts are summed as bigint and displayed exactly. Jupiter execution receipts remain separate and are not ownership inputs. NAV/value are explicitly unavailable. Live wallet connection is required by the UI; RPC failures never display zero or stale balances as current.

## Local checks

- `npm test`: 128 passed, including 14 behavioral positions tests covering binary token decoding, multiple accounts, transfers, exact large values, zero accounts, optional-intent isolation, invalid selectors and native read failures.
- `npm run typecheck`: passed after regenerating stale Next route types.
- `npm run build`: passed.
- ESLint over every changed TypeScript/TSX file: passed.
- `npm run lint`: existing unrelated errors in `src/components/providers/ui-provider.tsx` (set-state-in-effect) and `src/components/trade-approve.tsx` (refs and set-state-in-effect); four existing warnings. Not changed in this task.
- `git diff --check`: passed.

## Live read-only evidence

`devnet-share-position.json` is the actual successful native share read for the public deployer address at confirmed slot 498627408. Zero owned shares were observed. This is not evidence of a settled deposit, claim recovery, NAV, or successful vault roundtrip.

No browser, signer, airdrop, transaction broadcast, mainnet RPC, or second vault was used. Public funding and signing gates remain closed. No-mistakes pipeline validation follows the committed implementation handoff.
