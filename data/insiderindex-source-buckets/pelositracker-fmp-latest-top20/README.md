# TOP 20 — latest FMP holdings + txn cross-check

## Filter
- **Holdings = latest FMP annual year only** (older years removed)
- Rows are **deduped**; FMP pagination stops on repeated pages (provider quirk)
- PT top5 kept only under `pelosiTracker.topHoldingsOnly`

## Transactions
- FMP house/senate trades + PT filing ledger
- `txnCrosscheck` shows tickers in trades but not in latest holdings
- If annual book is empty → `fmpLatest.holdingsFromTransactions` (activity, not position sizes)

## Charts
- `pelosiTracker.performanceHistory`

Full per-person files: `profiles/*.json`  
Latest-year FMP raw: `fmp-raw-latest/*.json`
