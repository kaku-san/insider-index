# Devnet Invest rail

The person, published FMP index and legacy index rails share `src/components/vault-invest.tsx`. They offer a **separate execution-test preview**, not an investment in the displayed politician/model. The disclosed book, published weights and native observed holdings remain independent.

## Fixed existing identity

`devnet-contract.ts` owns the public identity from the finalized creation receipt:

- Vault: `Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8`
- Shares: `Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A`, six decimals
- Required SDK devnet USDC: `USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT`

No arbitrary network, mint, RPC endpoint, person-to-vault mapping or vault creation is accepted. Reads use the existing `NativeVaultBuilders` on a read-only connection to the public devnet RPC. Genesis, native account owner, creator/host, vault/share addresses and share decimals are checked by the native reader. The mainnet single-trade RPC configuration is never reused for this path.

## HTTP contract

Both endpoints accept JSON with `network: "devnet"`, the exact `vaultAccount` and `shareMint`, positive canonical `amountUsdcRaw`, and `owner` (an on-curve wallet address or `null`). UI decimal input is converted without floating-point rounding; the SDK's safe-integer limit applies. This read-only surface never authenticates a caller or authorizes funds on the strength of an owner address.

- `POST /api/vaults/devnet/preview`: `200` for a successful native observation, **not** a quote or readiness approval. Returns raw native supply, observed holdings/weights, connected owner's native shares/pending intent, host fee rates and explicit blockers. Estimated shares/NAV remain unavailable. Unavailable reads return `503`, never zero balances. Responses are `no-store`; observations span confirmed reads, not an atomic accounting snapshot.
- `POST /api/vaults/devnet/prepare`: requires owner plus preview `expectedStateHash`, rereads native state, and currently returns **503** with `requires: "wait"`, blockers and an empty transaction list. Changed state or an existing owner intent are explicit blockers. The response's ephemeral operation ID is diagnostic, not a persisted deposit/ownership row.
- `/api/indexes/quote` and `/api/indexes/execute` remain retired with **503**, no stub transaction/signature. No Jupiter multi-leg index route exists.

## Signing safety and remaining work

`DEVNET_DEPOSIT_SIGNING_ENABLED` is false in code, independent of public-funds release and environment. The UI invalidates previews after amount/wallet changes and ignores late responses; its sign handler prepares afresh and fails closed. The signature seam accepts only a live matching wallet and passes **devnet explicitly** to Privy. Fixture wallets cannot sign devnet. Mainnet remains only the unchanged default for the separate individual-trade feature.

No signed bytes are broadcast, persisted or submitted to legacy execute. No keeper/service signer, key file, airdrop, new vault or fund expenditure was used for this wiring. Do not lift the gate just because the sibling worker funds the test vault. First complete the integration README's native instruction/effect policy, settlement/minima, route/oracle/config, budget, operation-auth, broadcast and recovery work. The seam currently refuses even a forged READY response. There is no functioning end-to-end app deposit yet, and the button deliberately says so.

Host entry/exit bps are observed separately from unquoted protocol, network, rent, bounty and swap costs. Native settlement can require several stages; there is no fabricated share issuance, return curve or guaranteed USDC exit.

## Verification

- `tests/devnet-deposit.test.mts`: executable request validation, exact amounts, native-reader fixture observations, missing/current-owner/state blockers, endpoint status/no-store behavior, failed reads, and zero wallet calls under unreadiness/fixture/stale/forged-ready cases. Fixtures are not native funding evidence.
- Existing person/holdings rendering tests run inside the wallet provider and preserve all disclosed rows; generated HTML checks the separate test-vault label and disabled signing.
- `evidence/vaults/invest-devnet-preview.json`: real read-only native preview from this wiring task. At the recorded slot the existing test vault had zero raw share supply and zero recorded backing; this historical observation does not assert the outcome of a later parallel funded deposit.
- Local checks: `npm run typecheck`, `npm test` (114 passing), `npm run build`, and targeted ESLint passed. No browser was used. Full no-mistakes delivery is a separate supervisor-requested stage after this branch is committed.
