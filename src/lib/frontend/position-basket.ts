/** What a wallet actually holds versus the published target. Never treats the target as a holding. */

export const POSITION_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const POSITION_WSOL_MINT = "So11111111111111111111111111111111111111112";

const rawAmountPattern = /^(0|[1-9][0-9]*)$/;

export type BasketLeg = { ticker: string; mint: string; targetWeightBps?: number };
export type BasketHolding = { mint: string; amountRaw: string };

export type PositionBasketLeg = {
  ticker: string;
  mint: string;
  targetWeightBps: number;
  amountRaw: string;
  held: boolean;
};

export type PositionBasket = {
  targetCount: number;
  heldCount: number;
  legs: PositionBasketLeg[];
};

export type DepositFill = {
  targetCount: number;
  filledCount: number;
  filled: { ticker: string; mint: string; amountRaw: string }[];
  missing: { ticker: string; mint: string }[];
};

export type CashOutAsset = {
  mint: string;
  label: string;
  amountRaw: string;
  kind: "usdc" | "stock" | "other";
};

export const MAG7_FILL_CHECK = "Checking every name can be bought…";
export const CASH_OUT_CHECK = "Checking cash out…";
export const MAG7_CANNOT_FILL = "This amount cannot buy Mag7 right now.";
export const MAG7_FILL_TIMEOUT = "Mag7 could not be checked in time. Try that amount again.";
export const CASH_OUT_CHECK_TIMEOUT = "Cash out could not be checked in time. Try again.";
export const PREPARE_CHECK_MS = 45_000;
export const CASH_OUT_BEFORE_SIGN = "Cash out in one signature. If the vault's USDC buffer covers it you get USDC right away; otherwise the keeper sells your share of each stock and sends USDC within about a minute. Any stock that cannot be sold is sent to you as the token.";
export const CASH_OUT_STILL_NOTE = "These holdings are still on this cash-out. The keeper sells them to USDC; any stock that cannot be sold is sent to you as the token.";

function raw(amountRaw: string | undefined): bigint {
  if (!amountRaw || !rawAmountPattern.test(amountRaw)) return 0n;
  try { return BigInt(amountRaw); } catch { return 0n; }
}

/** Known vault balances versus published legs. A missing read is null, not an all-target book. */
export function basketVersusTarget(legs: readonly BasketLeg[] | null | undefined, holdings: readonly BasketHolding[] | null | undefined): PositionBasket | null {
  if (!Array.isArray(legs) || !legs.length || !holdings) return null;
  const amounts = new Map(holdings.map(holding => [holding.mint, holding.amountRaw]));
  const rows = legs.map(leg => {
    const amountRaw = amounts.get(leg.mint) ?? "0";
    const held = raw(amountRaw) > 0n;
    return {
      ticker: leg.ticker,
      mint: leg.mint,
      targetWeightBps: leg.targetWeightBps ?? 0,
      amountRaw: held ? amountRaw : "0",
      held,
    };
  });
  return { targetCount: rows.length, heldCount: rows.filter(leg => leg.held).length, legs: rows };
}

/** Share holders see the vault book. A zero share balance is not that book. */
export function heldBasket(sharesRaw: string, legs: readonly BasketLeg[] | null | undefined, holdings: readonly BasketHolding[] | null | undefined): PositionBasket | null {
  if (raw(sharesRaw) === 0n) return null;
  return basketVersusTarget(legs, holdings);
}

/** Names this deposit auction has actually bought. Zero amounts stay missing. */
export function depositFillVersusTarget(legs: readonly { ticker: string; mint: string }[], amounts: readonly { mint: string; amountRaw: string }[]): DepositFill {
  const byMint = new Map(amounts.map(row => [row.mint, raw(row.amountRaw)]));
  const filled: DepositFill["filled"] = [];
  const missing: DepositFill["missing"] = [];
  for (const leg of legs) {
    const amount = byMint.get(leg.mint) ?? 0n;
    if (amount > 0n) filled.push({ ticker: leg.ticker, mint: leg.mint, amountRaw: amount.toString() });
    else missing.push({ ticker: leg.ticker, mint: leg.mint });
  }
  return { targetCount: legs.length, filledCount: filled.length, filled, missing };
}

/** Leftover cash-out holdings. WSOL support is omitted. Unknown mints keep their address, not a made-up ticker. */
export function cashOutDelivery(tokens: readonly { mint: string; amountRaw: string }[] | null | undefined, labels: readonly { mint: string; ticker: string }[] = []): CashOutAsset[] {
  if (!tokens) return [];
  const byMint = new Map(labels.map(leg => [leg.mint, leg.ticker]));
  const assets: CashOutAsset[] = [];
  for (const token of tokens) {
    if (raw(token.amountRaw) === 0n || token.mint === POSITION_WSOL_MINT) continue;
    const ticker = byMint.get(token.mint);
    const kind = token.mint === POSITION_USDC_MINT ? "usdc" : ticker ? "stock" : "other";
    assets.push({
      mint: token.mint,
      label: kind === "usdc" ? "USDC" : ticker ?? token.mint,
      amountRaw: token.amountRaw,
      kind,
    });
  }
  return assets;
}

export function formatObservedAmount(asset: Pick<CashOutAsset, "kind" | "label" | "amountRaw">): string {
  if (asset.kind === "usdc" && rawAmountPattern.test(asset.amountRaw)) {
    const padded = asset.amountRaw.padStart(7, "0");
    const fraction = padded.slice(-6).replace(/0+$/, "");
    const whole = padded.slice(0, -6);
    return fraction ? `${whole}.${fraction} USDC` : `${whole} USDC`;
  }
  return `${asset.label} · ${asset.amountRaw} raw`;
}

export function heldBookSummary(basket: PositionBasket): string {
  const held = basket.legs.filter(leg => leg.held).map(leg => leg.ticker);
  const missing = basket.legs.filter(leg => !leg.held).map(leg => leg.ticker);
  if (basket.heldCount === 0) return `Holds none of ${basket.targetCount} target names.`;
  if (basket.heldCount === basket.targetCount) return `Holds all ${basket.targetCount} target names: ${held.join(", ")}.`;
  return `Holds ${held.join(", ")} (${basket.heldCount} of ${basket.targetCount}). Not held: ${missing.join(", ")}.`;
}

export function positionBookLine(position: {
  basket?: PositionBasket | null;
  pendingOperations?: { kind?: string; fill?: DepositFill }[] | null;
}): string | null {
  if (position.basket) return heldBookSummary(position.basket);
  const fill = position.pendingOperations?.find(operation => operation.kind === "deposit" && operation.fill)?.fill;
  if (!fill || fill.targetCount === 0) return null;
  if (fill.filledCount === 0) return `Bought none of ${fill.targetCount} target names yet. Not shares.`;
  return `Bought ${fill.filled.map(leg => leg.ticker).join(", ")} (${fill.filledCount} of ${fill.targetCount}) so far. Not shares yet.`;
}

export function cashOutDeliveryOf(position?: { pendingOperations?: { kind?: string; delivery?: CashOutAsset[] }[] | null } | null): CashOutAsset[] {
  return position?.pendingOperations?.find(operation => operation.kind === "withdraw" && operation.delivery?.length)?.delivery ?? [];
}

export type PrepareCheckStatus = "idle" | "checking" | "ready" | "blocked";

export function prepareRequestKey(input: { owner: string; network: string; mode: "deposit" | "withdraw"; amountRaw: string }): string {
  return JSON.stringify([input.owner, input.network, input.mode, input.amountRaw]);
}

/** Quote and cash-out checks stay on the form. A stack, hang, or blank failure becomes one human line. */
export function humanPrepareMessage(error: unknown, mode: "deposit" | "withdraw"): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.message === "QUOTE_TIMEOUT")) {
    return mode === "deposit" ? MAG7_FILL_TIMEOUT : CASH_OUT_CHECK_TIMEOUT;
  }
  const text = error instanceof Error ? error.message.trim() : "";
  if (text === MAG7_CANNOT_FILL || text.includes(MAG7_CANNOT_FILL)) return MAG7_CANNOT_FILL;
  if (!text || text.length > 200 || text.includes("\n") || /\bat\s+\S+\s+\(.+:\d+:\d+\)/.test(text) || text.startsWith("Error:")) {
    return mode === "deposit" ? "Mag7 could not be checked. Try that amount again." : "Cash out could not be checked. Try again.";
  }
  return text;
}

export function withPrepareTimeout<T>(work: Promise<T>, ms = PREPARE_CHECK_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("QUOTE_TIMEOUT"), { name: "TimeoutError" })), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Invest and cash-out sign stay disabled until the check for this amount passes. */
export function prepareCheckControl(mode: "deposit" | "withdraw", status: PrepareCheckStatus, authenticated: boolean): { label: string; enabled: boolean; status: string | null } {
  const checking = mode === "deposit" ? MAG7_FILL_CHECK : CASH_OUT_CHECK;
  if (!authenticated) return { label: "Connect to continue", enabled: true, status: null };
  if (status === "checking") return { label: checking, enabled: false, status: checking };
  if (status === "ready") return { label: mode === "deposit" ? "Invest" : "Cash out", enabled: true, status: null };
  return { label: mode === "deposit" ? "Invest" : "Cash out", enabled: false, status: null };
}
