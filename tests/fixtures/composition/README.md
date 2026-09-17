# Public native-program composition fixtures

These gzip files are public read-only captures, not signed transactions, keys, production writes or invented mints. They are committed so `npm test` needs no RPC or external service.

- `vm-snapshot.json.gz`: 63 account entries (including missing-account nulls), finalized slot **447813178**, captured **2026-09-17T14:03:15.821Z**. Existing Mag7 vault `AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`, creator and share identity came from the confirmed receipt linked in [the runbook](../../../docs/composition-resume.md). Includes the actual WSOL/USDC Raydium CLMM pool and the saved seven stock legs' oracle accounts.
- `definition.json.gz`: read-only persisted Mag7 definition, version 2, exact original seven-stock targets and source provenance. Not a DB write or a newly computed book.
- `share-supply.json`: projection from a **separate parsed share-mint account read**, slot **447809602**, 2026-09-17T13:44:14.967Z: supply 0, decimals 6. The original 63-account snapshot did not contain the raw share-mint account. The fixture RPC projects this value for the new empty-supply guard; it does NOT install a fabricated raw mint in the VM. Configuration instructions never mint/burn shares. This cannot support a deposit/mint simulation claim.
- `<program>.so.gz`: exact public deployed BASKT, SPL Token, Token-2022 and ATA binaries. Loader owners, ProgramData addresses and **uncompressed binary SHA-256** are recorded in `vm-snapshot.json.gz`; `tests/support/composition-vm.mts` checks the hashes before loading.

BASKT program: `BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate`

BASKT uncompressed SHA-256: `2445261ae65d8dd54bd968905b9c1b4220b6a194020b80bdef356aafada1fd49`

The harness uses LiteSVM **1.4.1**, captured Clock/Rent, zero signatures, packet-size checks and `simulateTransaction` only. `apply()` means **copy successful simulated postAccounts into this isolated in-memory VM**, then advance one slot for LUT activation. It is never a chain send. The RPC seam never mutates the VM and rejects unsupported methods; network fetch is forbidden by the regression test. Initial creator balances are the captured balances, not topped up. A synthetic WSOL residual in one separate unit test is explicitly labelled and does not feed the legal-sequence replay.

Evidence strength: this executes the actual application/SDK builders against captured deployed program bytes, reproduces the reported errors and checks native post-state. It is not a full historical bank replay, current-program attestation, funded roundtrip, liquidity/slippage proof, live pricing freshness check, security audit or receipt. `installed-composition.mts` is a separate synthetic verifier fixture for unit tests, not the native execution evidence.

Run: `node --experimental-strip-types --test tests/composition-resume.test.mts`

Do not refresh these captures silently, contact mainnet from tests, overwrite the production journal, or reinterpret simulation output as landed transactions. Refreshing an upgrade/account fixture needs a new documented read-only capture and review.
