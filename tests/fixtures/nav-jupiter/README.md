# Offline NAV venue fixtures

Public historical mainnet accounts, quote/build responses and deployed token/Jupiter/Raydium program bytes. `MANIFEST.json` hashes the **decompressed** bytes; the test helpers verify each file before loading it.

Retained from the prior captured venue fixtures at commit `9dc56c499e96a00ac08415fff6ff2d1e88b7c4f0`. `bank.json.gz` projects the required public mint, rent/clock and exit-route accounts from those captures; the seven-leg definition retains only pool/mint/weight metadata. No previous vault program or state is loaded. Raydium and Jupiter captures are retained because the NAV keeper tests execute those same venues; unrelated retired-program state and executable-account records were removed from the seven-pool bank.

- `jup-exit-*`: TSLA → USDC route, lookup tables, accounts and program hashes.
- `all-seven-*`: Raydium pool state, metadata and lookup tables for direct-route validation.
- `*.so.gz`: deployed token programs, associated-token program, Jupiter V6 and Raydium CLMM.

`tests/support/nav-jupiter-vm.mts` forbids network access. Funding/inventory mutations are **synthetic local test inputs**, not production receipts or liquidity evidence. `nav-vault-jupiter.test.mts` requires the same exact captured fill (609167 raw USDC) after the NAV PDA swap and exercises reserved-request fulfillment and settlement.
