# Mag7 deposit minimum

**Measured 2026-09-22T07:00:26Z UTC: Minimum is $1.**

This is the public Mag7 **route-coverage** floor. It replaces the old $0.03
one-raw-atom calculation: that calculation only established that a stock mint
could receive one atom and did not quote the user's weighted deposit slices.

## Live route check

The check used `buildCycleRoute` against the seven persisted Mag7 Raydium CLMM
pools for vault `AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`. Each candidate
was split at the live vault target weight, using
`floor(depositRaw × targetWeightBps / 10,000)`, then quoted USDC → that leg on
its persisted pool with the keeper's 50 bps slippage. A candidate passes only
when every direct Raydium route builds and its on-chain `minOutRaw` is positive.
This is a real slice quote, not a one-atom input probe.

| Leg | Weight (bps) | Pool |
| --- | ---: | --- |
| MSFT | 3,448 | `CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL` |
| AAPL | 2,740 | `ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT` |
| AMZN | 1,151 | `6m5aXAve4uh6Kt4ytKyCLWNMjd8PYP5vujwNCtycrUiD` |
| GOOGL | 1,424 | `B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw` |
| NVDA | 854 | `49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6` |
| META | 322 | `3L7KbPVaAQA4UTecaGQYsm6UCq5F3sZM9zAYkxqYt63j` |
| TSLA | 61 | `8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF` |

The following cells are `weighted USDC input raw → 50 bps min output raw`.
All output mints have eight decimals. Every quoted minimum is positive, so all
five candidates passed; $1 is the smallest candidate and is the enforced floor.

| Leg | $1 | $5 | $10 | $25 | $50 |
| --- | --- | --- | --- | --- | --- |
| MSFT | 344,800 → 67,534 | 1,724,000 → 337,676 | 3,448,000 → 675,353 | 8,620,000 → 1,688,381 | 17,240,000 → 3,376,757 |
| AAPL | 274,000 → 80,005 | 1,370,000 → 400,033 | 2,740,000 → 800,068 | 6,850,000 → 2,000,171 | 13,700,000 → 4,000,340 |
| AMZN | 115,100 → 44,110 | 575,500 → 220,552 | 1,151,000 → 441,156 | 2,877,500 → 1,102,889 | 5,755,000 → 2,205,779 |
| GOOGL | 142,400 → 39,572 | 712,000 → 197,864 | 1,424,000 → 395,729 | 3,560,000 → 989,323 | 7,120,000 → 1,978,646 |
| NVDA | 85,400 → 37,427 | 427,000 → 187,164 | 854,000 → 374,320 | 2,135,000 → 935,805 | 4,270,000 → 1,871,921 |
| META | 32,200 → 4,275 | 161,000 → 21,381 | 322,000 → 42,764 | 805,000 → 106,911 | 1,610,000 → 213,823 |
| TSLA | 6,100 → 1,613 | 30,500 → 8,070 | 61,000 → 16,141 | 152,500 → 40,355 | 305,000 → 80,712 |

The host's 25 bps entry fee is paid in native shares, not withheld from the
USDC contribution, so it does not reduce a quoted leg slice. Route availability
and prices are live conditions; a later route failure still fails closed rather
than substituting a different pool or weakening the 50 bps limit.
