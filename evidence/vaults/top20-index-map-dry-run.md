# Top-20 InsiderIndex vault-init dry-run

Source: `pelositracker-fmp-latest-top20.zip` (sha256 `70d7ebd9615a77df6ff89add9d93f0b31627a1c2d75e262397e3508d5d8cb533`).
Pool evidence: `https://api-v3.raydium.io/pools/info/mint` observed 2026-09-16T06:07:51.565Z (0.02h old, 32 pools / 193 unresolved).
Live Raydium snapshot. A leg is pool-ready only with a real, tradable USDC Raydium CLMM/CPMM pool above the TVL floor; thin/absent liquidity is a not-ready leg and drops out of tradable coverage.
Publish bars: tradable >= 50.0% publishes without caveat; tradable < 25.0% would misrepresent the book.
Catalog: snapshot. No signing, no broadcast, no keeper key.

- **Creatable now (>= 50.0% tradable): 2**
- Creatable but below publish bar: **1**
- Creatable but would misrepresent the book: **5**
- Blocked — insufficient tradable liquidity (structure ready): **2**
- Blocked — no mappable book: **10**

Catalog coverage = book weight that maps to a Solana mint. Tradable coverage = book weight behind a real, tradable pool (same whole-book basis). The gap is mapped-but-untradable weight, never re-weighted around.

| Person | Index | Verdict | Book | Mapped | Pool-ready | Catalog cov | Tradable cov | Untradable | Unmapped | Est. SOL |
|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|
| angus-s-jr-king | IIKING | blocked | fmp-annual-latest+txn | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| brandon-gill | IIGILL | blocked | txn-derived | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| cleo-fields | IIFIELDS | blocked | txn-derived | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| dan-sullivan | IISULLIV | blocked | fmp-annual-latest+txn | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| gilbert-ray-cisneros | IICISNER | blocked | txn-derived | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| jefferson-shreve | IISHREVE | blocked | txn-derived | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| josh-gottheimer | IIGOTTHE | creatable now | fmp-annual-latest+txn | 25 | 4 | 91.1% | 74.8% | 16.3% | 8.9% | 0.083 |
| julia-letlow | IILETLOW | creatable — WOULD MISREPRESENT (do not publish) | fmp-annual-latest+txn | 53 | 7 | 89.4% | 19.8% | 69.6% | 10.6% | 0.119 |
| kevin-hern | IIHERN | creatable — WOULD MISREPRESENT (do not publish) | fmp-annual-latest+txn | 8 | 2 | 89.3% | 16.1% | 73.2% | 10.7% | 0.059 |
| lisa-mcclain | IIMCCLAI | creatable — WOULD MISREPRESENT (do not publish) | fmp-annual-latest+txn | 45 | 9 | 58.8% | 21.4% | 37.4% | 41.2% | 0.143 |
| marjorie-taylor-greene | IIGREENE | creatable — WOULD MISREPRESENT (do not publish) | fmp-annual-latest+txn | 52 | 8 | 59.7% | 15.1% | 44.6% | 40.3% | 0.131 |
| nancy-pelosi | IIPELOSI | creatable now | fmp-annual-latest+txn | 18 | 5 | 96.9% | 70.3% | 26.5% | 3.1% | 0.095 |
| patrick-fallon | IIFALLON | blocked — insufficient tradable liquidity | fmp-annual-latest+txn | 21 | 1 | 33.7% | 2.8% | 30.9% | 66.3% | 0.287 |
| rick-scott | IISCOTT | blocked | fmp-annual-latest+txn | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| shelley-moore-capito | IICAPITO | blocked | fmp-annual-latest+txn | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| shri-thanedar | IITHANED | creatable — below publish bar | fmp-annual-latest+txn | 9 | 6 | 85.1% | 30.1% | 55.0% | 14.9% | 0.107 |
| susie-lee | IILEE | creatable — WOULD MISREPRESENT (do not publish) | fmp-annual-latest+txn | 18 | 3 | 24.2% | 5.9% | 18.3% | 75.8% | 0.071 |
| ted-budd | IIBUDD | blocked | fmp-annual-latest | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| tim-moore | IIMOORE | blocked | txn-derived | 0 | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.035 |
| vern-buchanan | IIBUCHAN | blocked — insufficient tradable liquidity | fmp-annual-latest+txn | 5 | 0 | 92.3% | 0.0% | 92.3% | 7.7% | 0.095 |

**Vaults the captain can honestly create today: 2** (creatable now, tradable coverage >= 50.0%).
Do not publish (tradable coverage too low, would misrepresent the book): julia-letlow, kevin-hern, lisa-mcclain, marjorie-taylor-greene, susie-lee.

Weights renormalise across mapped legs only; the unmapped share by weight is disclosed above.
A not-ready leg (thin/absent pool) never contributes to tradable coverage. Transaction-derived books carry no weights and are blocked. Cost is an estimate, not a quote.
