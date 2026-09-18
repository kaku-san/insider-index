# InsiderIndex — Consumer Index Full-Flow Rework

This package is the **consumer/social × editorial** InsiderIndex frontend rebuilt around the real product contract rather than a generic finance dashboard. Canonical product URL: **InsiderIndex.xyz**.

**Mental model:** Vanguard for famous people, built like a modern consumer social product.

People create discovery. Public disclosures create trust. The person index is the product. Copying one disclosure and owning native index shares remain separate money rails.

## Review these first

- `docs/insiderindex-fe/DESIGN-REWORK-V2.md` — product direction and signature system this rework follows.
- `docs/insiderindex-fe/CONSUMER-DESIGN-SYSTEM.md` — the consumer visual system (color, type, components).
- `docs/insiderindex-fe/FLOW-API-CONTRACT-AUDIT.md` — the implementation checklist reconciling UI, typed clients and backend state per area.

## Compact person portfolio

`/p/[id]` is intentionally short now:

1. person identity + real portrait + performance surface + Follow / Share / Index CTA;
2. tabs for Overview, Holdings, Moves and Sources;
3. Overview keeps holdings and recent moves in one compact band;
4. methodology, evidence and four-clock details live behind the Sources tab instead of extending the default page.

The offline performance curve is explicitly labelled `DESIGN PREVIEW CURVE`; it is not represented as production NAV.

## Connect flow

The consumer connect sheet supports the product states for:

- existing Solana wallet;
- email / embedded wallet entry point;
- connected wallet identity;
- disconnect;
- explicit transaction approval after connection.

Connection is never treated as trading authorization. In preview mode the connection is a local design-review session only.

## My Portfolio

`/positions` keeps two objects separate:

- **Index positions** — native vault share balances returned by the chain-backed index position API;
- **Copied moves** — historical single-disclosure fill receipts.

They are never summed into one fabricated NAV.

`/positions/[indexId]` is the authoritative native share-position detail and contains the exit entry point, outstanding claims and resumable operations.

## Money rails

### Track A — copy one public disclosure

```text
Feed
→ disclosure
→ POST /api/quote
→ user approves one Jupiter leg
→ POST /api/execute
→ durable copy-fill receipt
```

The quote request uses `mint`, `usdcAmount`, `side`, and optional `taker`. Copy is always one disclosure / one market leg.

### Track B — native person index

Entry:

```text
USDC amount
→ POST /api/indexes/:id/deposit/prepare
→ user approves contribution
→ intent observed on chain
→ separate lock approval when required
→ keeper pricing / auction / settlement
→ shares received
→ cleanup
→ complete
```

Exit:

```text
exact share amount
→ POST /api/indexes/:id/withdraw/prepare
→ user approves native redemption
→ claim every underlying token entitlement
→ tokens received
→ keep basket
   OR
→ separately approve conversion of verified redeemed credits only
→ complete USDC / partial USDC
```

A partial exit converts the entered share amount to raw units using the share mint decimals. It never silently sends the full wallet balance.

## Native operation API contract

The typed frontend adapter lives in `src/lib/frontend/vault-api.ts` and covers:

```text
GET  /api/vault-indexes/:id                 # published index readiness, release gate, vault/share identity
GET  /api/indexes/:id/position?owner=...     # wallet-scoped share position
POST /api/indexes/:id/deposit/prepare
POST /api/indexes/:id/withdraw/prepare
POST /api/operations/:id/receipts
GET  /api/operations/:id
POST /api/operations/:id/next
POST /api/operations/:id/convert/prepare
POST /api/operations/:id/recovery/prepare
```

The detailed state machines, SDK method mapping, authority boundaries, devnet identifiers and exit correctness rules are in `docs/insiderindex-fe/FLOW-API-CONTRACT-AUDIT.md`.

## Retired unsafe basket path

These old multi-leg endpoints are intentionally not used by executable UI:

```text
POST /api/indexes/quote
POST /api/indexes/execute
```

`src/components/index-ticket.tsx` is a fail-closed tombstone. Old stub basket payloads must never reach a wallet.

## Important implementation boundary

The frontend includes a typed same-origin native-vault boundary, but it does not infer funding availability from presentation state. Index pages expose preparation only when the published per-vault deposit gate, `publicFundsEnabled` release flag, and vault/share identity all validate; otherwise lifecycle calls fail closed and the page remains a preview.

The preparation UI is not a production-readiness claim: wallet ownership proof/session validation, RPC simulation, chain reconciliation and keeper infrastructure remain required before public funds are enabled.

## Design principles

- real people and real bundled portraits drive discovery;
- cobalt is the brand color; green/red remain market semantics;
- the joke is the premise, not casino UI;
- charts and imagery catch attention, while evidence becomes progressively available;
- Follow / Share / Invest actions stay obvious without putting every metric in a card;
- no glassmorphism, crypto neon, decorative gradients or generic AI-dashboard grids;
- motion explains state changes and approvals instead of decorating every viewport entrance.

## Public-inspired UI pass

The current design pass uses Public.com's Generated Assets / portfolio ergonomics as a reference for information hierarchy: asset-first rows, compact portfolio breakdowns, allocation before detail tables, and consumer brokerage review patterns. InsiderIndex keeps its own signal-orange brand, editorial politician photography, disclosure clocks, and native vault flow.

Company marks are bundled for the current reference holdings; unknown symbols fall back to a ticker monogram (no third-party logo network calls). Allocation now uses a segmented multi-color breakdown rather than a generic single-color donut.

## Validation

Run the standard project checks from the repository root (see `README.md` → Commands):

```bash
npm test
npm run lint
npm run typecheck
npm run build
```
