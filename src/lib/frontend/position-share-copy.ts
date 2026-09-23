/**
 * Positions and detail copy only. The on-chain share mint stays 6 decimals.
 * Decimal-shifting 20 raw units prints 0.00002, which reads as a price or dust.
 * USDC value is the main figure. The share count is the raw mint balance, labeled as units.
 */

const rawAmountPattern = /^(0|[1-9][0-9]*)$/;

export type PositionHoldingFigure = {
  role: "value" | "shares";
  text: string;
  label: string;
  primary: boolean;
};

function groupInteger(raw: string) {
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function knownDecimals(decimals?: number) {
  return Number.isInteger(decimals) && decimals! >= 0 && decimals! <= 255 ? decimals! : null;
}

/** Ordered figures: USDC value first, then an honestly labeled raw share count. */
export function positionHoldingFigures(input: {
  sharesRaw: string;
  shareDecimals?: number;
  valueText: string;
}): PositionHoldingFigure[] {
  const valueUnavailable = input.valueText === "—";
  const decimals = knownDecimals(input.shareDecimals);
  const raw = rawAmountPattern.test(input.sharesRaw) ? input.sharesRaw : null;
  const shareLabel = raw
    ? decimals === null ? "raw share units" : `raw share units · ${decimals} decimals`
    : "share units unavailable";
  return [
    {
      role: "value",
      text: input.valueText,
      label: valueUnavailable ? "value unavailable" : "USDC value",
      primary: true,
    },
    {
      role: "shares",
      text: raw ? groupInteger(raw) : "—",
      label: shareLabel,
      primary: false,
    },
  ];
}
