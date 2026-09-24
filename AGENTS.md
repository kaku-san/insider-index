<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# InsiderIndex — AI reviewer guide

InsiderIndex turns US politicians’ public stock disclosures into person and thematic indexes, showing complete books alongside explicitly labelled tradable slices. Users deposit USDC into a Solana NAV vault and receive Token-2022 shares in its stocks and cash; a separate keeper manages marks, swaps and rebalancing.

**Live app: [InsiderIndex.xyz](https://insiderindex.xyz)**

## Verify the claims

Receipts are dated evidence, not a fresh chain attestation. Explorer links below are mainnet; devnet receipts use devnet links. Offline tests exercise committed binaries, not necessarily the deployed bytes.

| Claim | Hard evidence / verification |
| --- | --- |
| Custom NAV program deployed on mainnet | Program [`HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB`](https://explorer.solana.com/address/HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB); [deployment and keeper receipts](evidence/vaults/nav-vault-mainnet.json) |
| Eight initialized vaults with share mints | Addresses below; [initialization signatures and slice coverage](evidence/vaults/nav-vault-slices-mainnet.json) |
| Atomic deposits, instant USDC withdrawals, reserved requests and keeper settlement | [nav-vault.test.mts](tests/nav-vault.test.mts); [devnet transaction receipts](evidence/vaults/nav-vault-devnet.json) (test tokens and mock venue, not mainnet liquidity) |
| Keeper authority and bounded venue swaps | [nav-vault.test.mts](tests/nav-vault.test.mts); [nav-vault-jupiter.test.mts](tests/nav-vault-jupiter.test.mts) executes captured Jupiter/Raydium programs offline |
| Pause preserves recovery; admin refund pays only the holder | `pause stops deposits…` and `admin refund…` tests in [nav-vault.test.mts](tests/nav-vault.test.mts) |
| Keeper price band and stale/same-slot refusal | `price band…` and `stale or same-slot marks…` tests in [nav-vault.test.mts](tests/nav-vault.test.mts); API stale-preparation refusal in [nav-vault-api.test.mts](tests/nav-vault-api.test.mts) |
| Excluded holdings stay disclosed; kept weights are renormalized | [nav-vault-slices.test.mts](tests/nav-vault-slices.test.mts); [data provenance](docs/data-sources.md) |
| Reproduce code-level checks | `npm ci`, then `npm run typecheck && npm test`, `npm run lint`, `npm run build`; local setup below |

Recorded eight-vault deployment (2026-09-23); readiness must still be read from chain:

| Index | Vault | Token-2022 share mint |
| --- | --- | --- |
| Mag7 Caucus | [2w5g5a…PseM6](https://explorer.solana.com/address/2w5g5aXmQj6o1cZSYbpV6R6rdK9KK7zAeJJRZu9PseM6) | [BZw8Se…Mv4A](https://explorer.solana.com/address/BZw8SegRiJmqmKgBDt5npmPo2dvsnv2nDPXvLQM6Mv4A) |
| Nancy Pelosi | [7TLXMd…hM8Q](https://explorer.solana.com/address/7TLXMdueAtbgNyQy6Ysrs7YoQxadyuK7fT5qxWathM8Q) | [8rHzNZ…eU1](https://explorer.solana.com/address/8rHzNZpq91DtyzThcfD9U2ePPEZbZQyY7yyrKit7NeU1) |
| Josh Gottheimer | [BPXmps…osVy](https://explorer.solana.com/address/BPXmpspgbBb5FmSzaxMurhMyRxqf6y1ZEAHWRzn4osVy) | [ERqqFa…yQu1](https://explorer.solana.com/address/ERqqFaBMq5BV5PEc9ySaHykQ7jmrCSvEj6sG6jwByQu1) |
| Shri Thanedar | [EGgFPV…oiBj](https://explorer.solana.com/address/EGgFPV88Y2CGqa3Jy89Zk95kBX5k66ps77Mb1pd2oiBj) | [6tq31T…VZCRY](https://explorer.solana.com/address/6tq31T85DAZxSNogyAFaVaQXBWXXD9bL4zmVcZrVZCRY) |
| Lisa McClain | [BwBjkw…2jFF](https://explorer.solana.com/address/BwBjkwnF8qoHFf41tptG3EyVu1cobZRiLSWpW1yw2jFF) | [5Kj8gM…TK6t](https://explorer.solana.com/address/5Kj8gMGVv4SJXpZTfR4bXA7Mg5AXAqpxGhhaYgWzTK6t) |
| Silicon Hill | [HfY7wv…WjVw](https://explorer.solana.com/address/HfY7wv2YhEAvkDr1yvua1GrR2EqMXe49Djt5zoSkWjVw) | [7hBqGd…rzGo](https://explorer.solana.com/address/7hBqGdEEq6xRSyRq4uQmWzbz3kXEeQERFAWySQmtrzGo) |
| Fresh Ink | [6BZDQM…4dPc](https://explorer.solana.com/address/6BZDQMXX4cHbvEiKHRqhUeF6LYuV6rzD48Tao4aF4dPc) | [FsUaca…9xG3](https://explorer.solana.com/address/FsUaca3nwDhC6MGYDWtZTbVfnrkJN2YPTHNq63p69xG3) |
| Bipartisan Handshake | [3GSFok…BKm7](https://explorer.solana.com/address/3GSFokxsLiy1LbygvQrRSAZkPEtAxJByMrrHtqVBBKm7) | [GS8CVU…mMta](https://explorer.solana.com/address/GS8CVUZREgkBEZsxRQZX4Z23g24MeM1jouuHgUP3mMta) |

## Repository map

| Path | Purpose |
| --- | --- |
| `src/app/`, `src/components/` | Next.js / React app, API routes and wallet UI |
| `programs/nav-vault/`, `programs/bin/` | Rust / Anchor program and hash-checked SBF binaries |
| `src/lib/nav-vault/` | Client, prepare/positions API and `keeper.ts` |
| `scripts/nav-vault-cli.mts` | Operator CLI; not a validation command |
| `src/lib/fmp/`, `src/lib/tracker/`, `src/lib/thematic/` | Disclosure ingestion, saved books and themes |
| `supabase/migrations/` | Append-only database history |
| `tests/`, `evidence/vaults/` | Offline Node/LiteSVM tests and dated transaction receipts |
| `docs/` | [Architecture](docs/architecture.md), [program safety](docs/nav-vault.md), [keeper](docs/keeper.md), [data sources](docs/data-sources.md) |

## How it works in five steps

1. Ingest disclosures into saved research books; show the complete allocation and source provenance.
2. Select a tradable slice using verified token identities and route evidence; renormalize included weights and asterisk exclusions.
3. User signs a USDC deposit; the NAV program charges the entry fee and mints proportional Token-2022 shares atomically.
4. The separate keeper posts marks and acquires/rebalances inventory through Jupiter, with Raydium fallback. NAV is free USDC plus marked stock inventory, excluding reserved withdrawals.
5. User burns shares for available USDC, or reserves a pro-rata withdrawal request for keeper settlement or owner-only in-kind delivery. Positions advance from observed chain state, not invented receipts.

## Live vs. limits

- Eight mainnet vaults are recorded; public deposits, cash-outs and positions use NAV only. Indexes without an on-chain vault remain Research; kill switches and chain readiness still govern access.
- **Unaudited, upgradeable program.** Admin pause, price override and holder-only in-kind refund powers are privileged. No guaranteed liquidity, principal protection or USDC-only exit; large in-kind exits can require additional claims.
- Full disclosed books remain visible, but vaults hold **tradable slices**, with excluded holdings asterisked. Disclosures are delayed; trade dollar bands are not exact balances.
- Marks are **keeper-posted**, sourced from Raydium/Jupiter, not a decentralized oracle. Mainnet marks expire after **60 seconds**; stale deposits and instant withdrawals refuse. Shares can initially represent cash awaiting investment.
- **Deployed bytes differ from the newer committed binary**, which adds `set_max_price_age` and is not deployed on mainnet. See [exact hashes and build evidence](docs/nav-vault.md#deployment-and-build-evidence). Offline tests do not prove current liquidity or a funded mainnet roundtrip.

## Run and test locally

Use **Node.js 22.18+** and npm. For a credential-free, read-only preview:

```sh
npm ci
cp .env.example .env.local
printf '\nNEXT_PUBLIC_INSIDERINDEX_PREVIEW=1\n' >> .env.local
npm run dev
```

Local URL: `http://localhost:3000`. Preview writes are disabled. For real saved data and wallet configuration, follow [README local setup](README.md#run-locally) and `.env.example`; never expose service-role or operator secrets in `NEXT_PUBLIC_*` variables.

```sh
npm run typecheck && npm test
npm run lint
npm run build
```

Tests are offline: no funded wallet, RPC credentials, browser or validator required. Agent validation is code-level only: **no browser, screenshots or DOM dumps; no live signing, deployment, upgrade, pause or keeper lifecycle actions**. Rust rebuilds (not needed for these tests): `bash scripts/nav-vault-build.sh`; see [toolchain requirements](docs/nav-vault.md#rebuilding-and-tests).

## Built by

**Kaku** · [github.com/kaku-san](https://github.com/kaku-san) · [x.com/kakujain](https://x.com/kakujain)

## Contributing

Before modifying the project, read and follow [CONTRIBUTING.md](CONTRIBUTING.md): contributor guardrails, key custody, data contracts and validation rules remain mandatory.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
