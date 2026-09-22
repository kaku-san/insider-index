# Mag7 deposit minimum

**Measured 2026-09-22 UTC: Minimum is $0.03.** This is a mechanical floor, not a recommended investment size.

The direct-deposit rail contributes USDC to the native vault; the user and keeper pay their transaction fees separately in SOL. The displayed USDC floor includes the current USDC value of those required transaction fees as the requested all-in minimum, but a connected user wallet and the keeper wallet must still hold the SOL itself. SOL cannot be paid from the USDC contribution.

## Live route check

The measurement used `buildCycleRoute` against the seven persisted Mag7 CLMM pools for vault `AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh`, with its persisted weights and the keeper's 50 bps slippage limit. The route builder quotes the actual Raydium pool, including its pool fee; it accepts a route only when the on-chain minimum output is non-zero.

At 2026-09-22T04:17:56.093Z, a zero-slippage live TSLA quote for 5 raw USDC returned 1 raw TSLA atom. That fact alone is not enough for the floor: with the keeper's 50 bps limit the output minimum must also be at least one atom. The smallest live inputs that produced a 1-atom on-chain minimum were:

| Leg | Weight (bps) | Pool-fee-inclusive input (raw USDC) | Expected output (raw atoms) | On-chain minimum (raw atoms) | Whole-deposit lower bound (raw USDC) |
| --- | ---: | ---: | ---: | ---: | ---: |
| MSFT | 3,448 | 12 | 2 | 1 | 35 |
| AAPL | 2,740 | 8 | 2 | 1 | 30 |
| AMZN | 1,151 | 7 | 2 | 1 | 61 |
| GOOGL | 1,424 | 9 | 2 | 1 | 64 |
| NVDA | 854 | 6 | 2 | 1 | 71 |
| META | 322 | 16 | 2 | 1 | 497 |
| TSLA | 61 | 9 | 2 | 1 | 1,476 |

For each leg, the lower bound is `ceil(legInputRaw × 10,000 / legWeightBps)`. Therefore the allocation-only Mag7 bound is `max(bounds) = 1,476` raw USDC, or $0.001476. The host's 25 bps entry fee is paid in native shares, not withheld from the contributed USDC, so it does not reduce a leg's Raydium input.

## Transaction-fee allowance

A live `getFeeForMessage` read at slot 449268054 measured the compacted user deposit-and-lock transaction at 30,000 lamports. The keeper's fill wire uses a 1,400,000 compute-unit limit and 25,000 micro-lamports/CU: 5,000 base lamports + 35,000 priority lamports = 40,000 lamports per fill. Seven legs need four two-swap-capped fill transactions, so the keeper allowance is 160,000 lamports.

That is 190,000 lamports (0.00019 SOL) in total. Raydium's live SOL price read was 117.05174002421539 USDC/SOL, making the fee allowance 0.022239830604600924 USDC. The exact combined amount is:

```text
0.001476 USDC allocation bound
+ 0.022239830604600924 USDC SOL-fee allowance
= 0.023715830604600924 USDC
```

Rounding only that result up to the next USDC cent gives **$0.03**.

## Same method for a 10-stock book

For any 10-stock definition, live-quote each persisted Raydium leg with the same keeper slippage limit. Let `q_i` be the smallest raw-USDC input whose route has a non-zero `minOutRaw`, and `w_i` its target bps. Its allocation bound is still:

```text
allocationRaw = max_i ceil(q_i × 10,000 / w_i)
```

Ten legs require `ceil(10 / 2) = 5` capped fill transactions, so the current transaction-fee allowance is `30,000 + 5 × 40,000 = 230,000` lamports. Convert that SOL amount using a live SOL/USDC quote, add it to `allocationRaw / 1,000,000`, then round up once to cents. There is intentionally no guessed universal 10-stock dollar minimum: prices, pool fees, weights, and the live SOL quote determine it.
