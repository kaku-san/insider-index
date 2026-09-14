# STOCKLANA-FMP-0 — Phase-0 FMP audit

**Verdict: `BLOCKED_NO_KEY`**
**Audited at:** 2026-09-14T11:10:05Z

Phase-0 is an access and display-rights check only. This audit did not invent an FMP key and did not call Financial Modeling Prep.

## Findings

- **No FMP key on Stocklana Dev cards.** `FMP_API_KEY` (and any FMP alias) is absent from the Stocklana Dev secret cards, from `.env.example`, and from committed repo files. `fmp_key_present` is `false`.
- **0 FMP requests.** `fmp_probe.request_count` is `0`. The probe was skipped because there is no key to send. Calling FMP without a key, or fabricating one, is out of scope for Phase-0.
- **Form4API adjacent: 2 congress calls.** The only adjacent live disclosure traffic observed during this audit was Form4API House PTR congress (`/v1/congress/trades`) — two calls. Those are not FMP requests and do not substitute for an FMP Senate/House probe.
- **Gates.** `Access` is **FAIL** (no key, no authorized FMP session). `Public_display_rights` is **OWNER_PENDING** (we have not confirmed a license that would let Stocklana show FMP-derived holdings, prices, or reconstructed books in the product UI).

## Design note — honest Pelosi-Tracker-close

Given `BLOCKED_NO_KEY`, Stocklana stays on the honest Pelosi-Tracker-close path already in V1:

- Every filer's **full disclosed book** remains the filing tape we actually hold (EDGAR Form 4, AInvest / Form4API PTRs). Every ticker stays visible, tradable or not.
- PTR sizes stay dollar **bands** (`amountLow` / `amountHigh`). Never invent share counts, last prices, or portfolio weights from FMP.
- Return / hit rate stay `—` until a real dated-trade price series exists.
- Readiness gates only **Buy this index**. A thin or incomplete book is shown as thin or incomplete — not filled in from a vendor we cannot access.

Pelosi Tracker is the completeness *target*, not a license to hallucinate the missing names. Without FMP Access and without `Public_display_rights`, we do not pretend FMP can close the gap.

## Recommendation

**Do not buy FMP yet.**

Access has failed and public display rights are still owner-pending. A paid FMP plan would not change this Phase-0 verdict: we still lack a key on Stocklana Dev cards, we still have not probed FMP, and we still have no owner confirmation that FMP data may be shown in the product. Revisit only after a key is placed on the Dev cards *and* display rights are explicit. Until then FMP stays out of V1 (same bucket as Quiver, EODHD, Bloomberg).

Machine-readable copy: [`fmp-audit.json`](./fmp-audit.json). No secrets in either file.
