<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# InsiderIndex — AI reviewer guide

Start with the [README](README.md) for the product, judge demo, mainnet deployment, repository map, local setup and current limitations. This guide maps the principal claims to reviewable evidence.

**Live app: [InsiderIndex.xyz](https://insiderindex.xyz)**

## Verify the claims

Receipts are dated evidence, not a fresh chain attestation. Explorer links in the deployment docs are mainnet unless marked devnet. Offline tests exercise committed binaries, not necessarily the deployed bytes.

| Claim | Hard evidence / verification |
| --- | --- |
| Custom NAV program deployed on mainnet | [Program deployment details and exact hashes](docs/nav-vault.md#deployment-and-build-evidence); [deployment and keeper receipts](evidence/vaults/nav-vault-mainnet.json) |
| Eight initialized vaults with share mints | [Deployment addresses](README.md#mainnet-deployment); [initialization signatures and slice coverage](evidence/vaults/nav-vault-slices-mainnet.json) |
| Atomic deposits, instant USDC withdrawals, reserved requests and keeper settlement | [nav-vault.test.mts](tests/nav-vault.test.mts); [devnet transaction receipts](evidence/vaults/nav-vault-devnet.json) (test tokens and mock venue, not mainnet liquidity) |
| Keeper authority and bounded venue swaps | [nav-vault.test.mts](tests/nav-vault.test.mts); [nav-vault-jupiter.test.mts](tests/nav-vault-jupiter.test.mts) executes captured Jupiter/Raydium programs offline |
| Pause preserves recovery; admin refund pays only the holder | `pause stops deposits…` and `admin refund…` tests in [nav-vault.test.mts](tests/nav-vault.test.mts) |
| Keeper price band and stale/same-slot refusal | `price band…` and `stale or same-slot marks…` tests in [nav-vault.test.mts](tests/nav-vault.test.mts); API stale-preparation refusal in [nav-vault-api.test.mts](tests/nav-vault-api.test.mts) |
| Excluded holdings stay disclosed; kept weights are renormalized | [nav-vault-slices.test.mts](tests/nav-vault-slices.test.mts); [data provenance](docs/data-sources.md) |
| Reproduce code-level checks | Follow [contributor validation](CONTRIBUTING.md#validation); use the [README](README.md#run-locally) for setup |

Read the detailed system boundaries in [architecture](docs/architecture.md), program behavior and deployment evidence in [NAV vault](docs/nav-vault.md), operator controls in [keeper](docs/keeper.md), and disclosure provenance in [data sources](docs/data-sources.md).

Agent validation is code-level only: **no browser, screenshots or DOM dumps; no live signing, deployment, upgrade, pause or keeper lifecycle actions**. Offline tests do not prove current liquidity or a funded mainnet roundtrip.

## Contributing

Before modifying the project, read and follow [CONTRIBUTING.md](CONTRIBUTING.md): contributor guardrails, key custody, data contracts and validation rules remain mandatory.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
