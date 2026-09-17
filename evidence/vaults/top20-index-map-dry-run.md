# All-20 InsiderIndex vault-init dry-run

Source: `pelositracker-fmp-latest-top20.zip` (sha256 `70d7ebd9615a77df6ff89add9d93f0b31627a1c2d75e262397e3508d5d8cb533`) for the 10 person books; the 10 thematic baskets come from the merged research feed.
Pool evidence: `https://api-v3.raydium.io/pools/info/mint` observed 2026-09-17T06:19:38.462Z (0.02h old, 34 pools / 194 unresolved).
Live Raydium snapshot. A leg is pool-ready only with a real, tradable USDC Raydium CLMM/CPMM pool above the TVL floor; thin/absent liquidity is a not-ready leg and drops out of tradable coverage.
Publish bars: tradable >= 50.0% publishes without caveat; tradable < 25.0% would misrepresent the book.
Catalog: snapshot. No signing, no broadcast, no keeper key.

- Published indexes: **20** (person **10**, thematic **10**)
- Creatable now (>= 50.0% tradable): **6**
- Creatable but below publish bar: **4**
- Creatable but would misrepresent the book: **6**
- Deposit-ready (per-vault gate; still release-gated): **1**
- Blocked — insufficient tradable liquidity (structure ready): **4**
- Blocked — no mappable book: **0**
- Estimated total creation cost for all 20: **2.308000 SOL** (2308000000 lamports)
- Deposits are additionally gated by VAULT_RELEASE.publicFundsEnabled (currently off).

Catalog coverage = book weight that maps to a Solana mint. Tradable coverage = book weight behind a real, tradable pool (same whole-book basis). The gap is mapped-but-untradable weight, never re-weighted around.

| Kind | Index | Symbol | Verdict | Deposit-ready | Book | Mapped | Pool-ready | Catalog cov | Tradable cov | Untradable | Est. SOL |
|---|---|---|---|:--:|---|--:|--:|--:|--:|--:|--:|
| person | josh-gottheimer | IIGOTTHE | creatable now | no | fmp-annual-latest+txn | 25 | 4 | 91.1% | 74.8% | 16.3% | 0.083000 |
| person | julia-letlow | IILETLOW | creatable — WOULD MISREPRESENT (do not publish) | no | fmp-annual-latest+txn | 53 | 7 | 89.4% | 19.8% | 69.6% | 0.119000 |
| person | kevin-hern | IIHERN | creatable — WOULD MISREPRESENT (do not publish) | no | fmp-annual-latest+txn | 8 | 2 | 89.3% | 16.1% | 73.2% | 0.059000 |
| person | lisa-mcclain | IIMCCLAI | creatable — WOULD MISREPRESENT (do not publish) | no | fmp-annual-latest+txn | 45 | 9 | 58.8% | 21.4% | 37.4% | 0.143000 |
| person | marjorie-taylor-greene | IIGREENE | creatable — WOULD MISREPRESENT (do not publish) | no | fmp-annual-latest+txn | 52 | 8 | 59.7% | 15.1% | 44.6% | 0.131000 |
| person | nancy-pelosi | IIPELOSI | creatable now | no | fmp-annual-latest+txn | 18 | 5 | 96.9% | 70.3% | 26.5% | 0.095000 |
| person | patrick-fallon | IIFALLON | blocked — insufficient tradable liquidity | no | fmp-annual-latest+txn | 21 | 1 | 33.7% | 2.8% | 30.9% | 0.287000 |
| person | shri-thanedar | IITHANED | creatable — below publish bar | no | fmp-annual-latest+txn | 8 | 6 | 85.1% | 36.1% | 49.0% | 0.107000 |
| person | susie-lee | IILEE | creatable — WOULD MISREPRESENT (do not publish) | no | fmp-annual-latest+txn | 18 | 3 | 24.2% | 5.9% | 18.3% | 0.071000 |
| person | vern-buchanan | IIBUCHAN | blocked — insufficient tradable liquidity | no | fmp-annual-latest+txn | 5 | 0 | 92.3% | 0.0% | 92.3% | 0.095000 |
| thematic | beta-caucus | IITBETCA | creatable — WOULD MISREPRESENT (do not publish) | no | insiderindex-thematic | 15 | 2 | 100.0% | 13.0% | 87.0% | 0.059000 |
| thematic | bipartisan-handshake | IITBIPHA | creatable now | no | insiderindex-thematic | 5 | 3 | 100.0% | 60.0% | 40.0% | 0.071000 |
| thematic | capitol-arsenal | IITCAPAR | blocked — insufficient tradable liquidity | no | insiderindex-thematic | 6 | 0 | 100.0% | 0.0% | 100.0% | 0.107000 |
| thematic | capitol-cluster | IITCAPCL | creatable — below publish bar | no | insiderindex-thematic | 25 | 9 | 100.0% | 36.0% | 64.0% | 0.143000 |
| thematic | dual-lock | IITDUALO | creatable — below publish bar | no | insiderindex-thematic | 20 | 6 | 100.0% | 30.0% | 70.0% | 0.107000 |
| thematic | fresh-ink | IITFREIN | creatable now | no | insiderindex-thematic | 20 | 8 | 100.0% | 73.6% | 26.4% | 0.131000 |
| thematic | house-heat | IITHOUHE | creatable — below publish bar | no | insiderindex-thematic | 15 | 7 | 100.0% | 46.7% | 53.3% | 0.119000 |
| thematic | mag7-caucus | IITMAGCA | creatable now | yes | insiderindex-thematic | 7 | 7 | 100.0% | 100.0% | 0.0% | 0.119000 |
| thematic | silicon-hill | IITSILHI | creatable now | no | insiderindex-thematic | 18 | 10 | 100.0% | 90.7% | 9.3% | 0.155000 |
| thematic | whips-desk | IITWHIDE | blocked — insufficient tradable liquidity | no | insiderindex-thematic | 6 | 1 | 100.0% | 9.6% | 90.4% | 0.107000 |

**Total to create all 20: 2.308000 SOL** (estimate, not a quote).
Pilot person index nancy-pelosi (18 mapped legs): **0.095000 SOL** to create.

Thematic baskets ranked by real tradable coverage (the honest basis for choosing which to fund):
| Rank | Thematic index | Tradable cov | Catalog cov | Pool-ready / mapped | Verdict |
|--:|---|--:|--:|--:|---|
| 1 | mag7-caucus | 100.0% | 100.0% | 7 / 7 | creatable now |
| 2 | silicon-hill | 90.7% | 100.0% | 10 / 18 | creatable now |
| 3 | fresh-ink | 73.6% | 100.0% | 8 / 20 | creatable now |
| 4 | bipartisan-handshake | 60.0% | 100.0% | 3 / 5 | creatable now |
| 5 | house-heat | 46.7% | 100.0% | 7 / 15 | creatable — below publish bar |
| 6 | capitol-cluster | 36.0% | 100.0% | 9 / 25 | creatable — below publish bar |
| 7 | dual-lock | 30.0% | 100.0% | 6 / 20 | creatable — below publish bar |
| 8 | beta-caucus | 13.0% | 100.0% | 2 / 15 | creatable — WOULD MISREPRESENT (do not publish) |
| 9 | whips-desk | 9.6% | 100.0% | 1 / 6 | blocked — insufficient tradable liquidity |
| 10 | capitol-arsenal | 0.0% | 100.0% | 0 / 6 | blocked — insufficient tradable liquidity |

Do not publish (tradable coverage too low, would misrepresent the book): julia-letlow, kevin-hern, lisa-mcclain, marjorie-taylor-greene, susie-lee, beta-caucus.

Weights renormalise across mapped legs only; the unmapped share by weight is disclosed above.
Creation is cheap and ungated; deposits stay CLOSED until every mapped leg has an observed tradable pool, and the release flag governs going live.
A not-ready leg (thin/absent pool) never contributes to tradable coverage. Transaction-derived books carry no weights and are blocked. Cost is an estimate, not a quote.

Not publishable as an index (10 people, no weightable book): angus-s-jr-king (no-ticker-holdings-in-annual-book), brandon-gill (txn-derived-book), cleo-fields (txn-derived-book), dan-sullivan (no-ticker-holdings-in-annual-book), gilbert-ray-cisneros (txn-derived-book), jefferson-shreve (txn-derived-book), rick-scott (no-ticker-holdings-in-annual-book), shelley-moore-capito (no-ticker-holdings-in-annual-book), ted-budd (no-ticker-holdings-in-annual-book), tim-moore (txn-derived-book).
