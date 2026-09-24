# InsiderIndex

**Public disclosures → transparent stock indexes → one-signature investing on Solana.** InsiderIndex turns US politicians’ disclosed stock books into person and thematic indexes. Explore the complete disclosed allocation, see exactly which holdings can trade on Solana, and invest USDC into that tradable slice through our own NAV vault program. Token-2022 shares represent a proportional claim on the vault’s stocks and cash; a separate keeper acquires and rebalances the stocks through Jupiter, with Raydium fallback.

**[Live app: InsiderIndex.xyz](https://insiderindex.xyz)** · [Architecture](docs/architecture.md) · [Program & safety](docs/nav-vault.md) · [Keeper](docs/keeper.md) · [Data sources](docs/data-sources.md)

For AI reviewers: see [AGENTS.md](AGENTS.md).

## 60-second demo

1. Open [InsiderIndex.xyz](https://insiderindex.xyz) and choose a person or theme.
2. Open [Mag7 Caucus](https://insiderindex.xyz/indexes/idx-theme-mag7-caucus). Inspect **Allocation** and the source labels. Compare with [Pelosi](https://insiderindex.xyz/indexes/insiderindex-nancy-pelosi): excluded holdings remain visible with an asterisk and a reason.
3. On a **Live** index, connect a Solana wallet and inspect **Invest**. The minimum is $10 USDC, plus SOL for network fees. Nothing moves without approval; judges can inspect without funding or signing.
4. If eligible and intentionally testing with real funds, approve once: USDC enters and shares mint atomically. See the observed position at [/positions](https://insiderindex.xyz/positions). Cash out also starts with one approval: available USDC pays immediately; otherwise a withdrawal request reserves your portion for keeper settlement or in-kind delivery.

This is **unaudited mainnet software**, not a risk-free demo. Do not invest money you cannot lose. Access restrictions and token-issuer terms apply.

## How it works

```text
Disclosures → complete research book → explicitly labelled tradable slice
                                           ↓
                                    user deposits USDC
                                           ↓
                              NAV vault mints Token-2022 shares
                                           ↕
                              keeper: marks, swaps, rebalances
                                           ↓
                           exit: USDC buffer / request / in kind
```

NAV is **free USDC + marked stock inventory**, excluding assets reserved for withdrawals. It is not the politician’s disclosed wealth, a trade receipt total, or a USDC-only balance. Full books stay visible even when only part of the book is investable.

## Mainnet deployment

Program: [`HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB`](https://explorer.solana.com/address/HWHfPmyC2TKAL1tCdDZyK4ajG1HJnhbEMGRQzGfwYisB).

Eight vaults recorded in the [deployment receipts](evidence/vaults/nav-vault-slices-mainnet.json) (2026-09-23). Links are mainnet; runtime readiness always comes from chain.

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

**Build transparency:** the committed mainnet binary adds an admin price-age instruction that is **not deployed**. Mainnet retains 60-second marks. Exact hashes and the deployment/source distinction are documented in [nav-vault.md](docs/nav-vault.md#deployment-and-build-evidence).

## Repository map & stack

| Path | Purpose |
| --- | --- |
| `src/app/`, `src/components/` | Next.js 16 / React 19 app and API; TypeScript, Tailwind CSS, Privy Solana wallets |
| `programs/nav-vault/` | Our Rust / Anchor 0.31 vault program |
| `programs/mock-swap/`, `programs/bin/` | Devnet-only test venue; hash-checked SBF binaries |
| `src/lib/nav-vault/` | Program client, prepare/positions API, NAV math integration, keeper |
| `scripts/nav-vault-cli.mts` | Operator CLI: init, keeper, pause/unpause, slice publication |
| `src/lib/index-vaults/` | Shared research definitions, catalog/pool evidence, venue builders; no retired vault SDK |
| `src/lib/fmp/`, `src/lib/tracker/`, `src/lib/thematic/` | Disclosure ingestion, saved books, themes |
| `supabase/migrations/` | Saved-source and index schema; deployed migration history retained |
| `tests/`, `evidence/vaults/`, `docs/` | Offline Node/LiteSVM tests, dated NAV receipts, technical guides |

## Run locally

Use **Node.js 22.18+** and npm. Rust/Solana tools are only needed to rebuild the programs, not to run the app or tests.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. For a **read-only UI preview without credentials**, set `NEXT_PUBLIC_INSIDERINDEX_PREVIEW=1` in `.env.local`; preview writes are disabled. Without preview or saved-data credentials, unavailable data is labelled rather than fabricated.

For real data and wallet interaction, configure `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an RPC provider (`HELIUS_API_KEY` recommended). Apply the Supabase migrations in filename order to your own database and ingest/publish saved books as described in [data-sources.md](docs/data-sources.md). The NAV keeper additionally needs `JUPITER_API_KEY`. Never put service-role, RPC, Jupiter, or wallet secrets in `NEXT_PUBLIC_*` variables. `.env.example` is the configuration reference.

```sh
npm run typecheck
npm test
npm run lint
npm run build
```

Tests run offline, including LiteSVM execution of our program and captured Jupiter/Raydium programs. They require no funded wallet, RPC credentials, browser, or validator. See [program build instructions](docs/nav-vault.md#rebuilding-and-tests) for Rust changes.

## Live vs. limits

- **Live:** eight mainnet NAV vaults, user-signed deposits/withdrawals, observed positions, and a separate automated keeper. An index without an on-chain NAV vault stays Research.
- **Tradable slices:** excluded holdings are asterisked, not hidden. Included weights are renormalized; the vault is not a perfect copy of the full disclosed book.
- **Pricing:** keeper-posted marks, not a decentralized oracle. Mainnet marks expire after **60 seconds**; stale deposits refuse and may need a retry after the next keeper update. Shares may initially represent cash awaiting investment.
- **Costs:** recorded vault settings are 0.25% entry fee, 5% cash buffer, and no host exit fee; network fees, swap slippage and token-issuer risks still apply.
- **Trust:** unaudited, upgradeable program; admin pause, price override and holder-only in-kind refund authority. No guaranteed liquidity, USDC-only exit, return or principal protection.
- **Data:** delayed disclosures and source coverage gaps are shown explicitly. Trade bands are not precise balances. Feed rows are research-only; individual copy-trade infrastructure is separate from vault ownership.
- The previous Symmetry integration and its operator UI have been removed. No chain state or deployed database history is modified by this cleanup.

## Built by

**Kaku** · [GitHub: kaku-san](https://github.com/kaku-san) · [X: @kakujain](https://x.com/kakujain)

No hackathon-specific rules document was supplied; this guide covers the demo, implementation, deployment evidence and limitations without claiming event-specific compliance.
