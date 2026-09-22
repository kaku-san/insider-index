# Mag7 deposit minimum

**Measured 2026-09-22T10:33:43.969Z UTC: Minimum is $1.** Deposits remain
paused; this route measurement does not change any release gate.

This is the public Mag7 **route-coverage** floor. It replaces the prior
unverified $1 value with a live, weighted-slice check against the installed
Mag7 definition. It is **not** proof that a later contribution can fill: deposit
prepare quotes all seven weighted Raydium slices at the requested size before
`buyVaultTx`/lock (`mag7-deposit-slices.ts`) and refuses with "This amount cannot
buy Mag7 right now" if any name cannot fill.

## Live route check

The check read the persisted seven-leg Mag7 definition for vault
`AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`, then ran
`buildCycleRoute` on each persisted Raydium CLMM pool. A $1 contribution
(`1,000,000` raw USDC) was split using
`floor(depositRaw × targetWeightBps / 10,000)`, with the keeper's 50 bps
slippage. Each route must build and have a positive on-chain `minOutRaw`.

The seven routes were read sequentially from one alternate mainnet RPC without
sleeping to avoid rate limits. Their 60-second quote validity windows overlap:
the last quote began at `2026-09-22T10:33:54.006Z` and the first expires at
`2026-09-22T10:34:43.975Z`. Therefore all seven live routes were valid at once
for 49.969 seconds.

All output mints have eight decimals. Cells are `weighted USDC input raw →
expected output raw → 50 bps minimum output raw`.

| Leg | Weight (bps) | Pool | Live quote |
| --- | ---: | --- | --- |
| MSFT | 3,448 | `CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL` | 344,800 → 67,974 → 67,634 |
| AAPL | 2,740 | `ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT` | 274,000 → 80,498 → 80,095 |
| AMZN | 1,151 | `6m5aXAve4uh6Kt4ytKyCLWNMjd8PYP5vujwNCtycrUiD` | 115,100 → 44,162 → 43,941 |
| GOOGL | 1,424 | `B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw` | 142,400 → 39,623 → 39,424 |
| NVDA | 854 | `49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6` | 85,400 → 37,508 → 37,320 |
| META | 322 | `3L7KbPVaAQA4UTecaGQYsm6UCq5F3sZM9zAYkxqYt63j` | 32,200 → 4,324 → 4,302 |
| TSLA | 61 | `8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF` | 6,100 → 1,612 → 1,603 |

The host's 25 bps entry fee is paid in native shares, not withheld from the
USDC contribution, so it does not reduce a quoted leg slice. Route availability
and prices are live conditions: a later failure still fails closed rather than
substituting a pool or weakening the 50 bps limit.
