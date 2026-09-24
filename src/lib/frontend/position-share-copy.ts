/**
 * Positions and detail copy only. USDC value is the main figure. NAV vault shares are worth roughly a
 * dollar each, so the share count is the human mint balance ("9.975 shares", exact to the mint's
 * decimals). Raw units appear only when the decimals are unknown, labeled as units.
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

function humanShares(raw: string, decimals: number) {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${groupInteger(whole)}.${fraction}` : groupInteger(whole);
}

/** Ordered figures: USDC value first, then the human share count (raw units only without decimals). */
export function positionHoldingFigures(input: {
  sharesRaw: string;
  shareDecimals?: number;
  valueText: string;
}): PositionHoldingFigure[] {
  const valueUnavailable = input.valueText === "—";
  const decimals = knownDecimals(input.shareDecimals);
  const raw = rawAmountPattern.test(input.sharesRaw) ? input.sharesRaw : null;
  const shareText = raw ? decimals === null ? groupInteger(raw) : humanShares(raw, decimals) : "—";
  const shareLabel = raw
    ? decimals === null ? "raw share units" : shareText === "1" ? "share" : "shares"
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
      text: shareText,
      label: shareLabel,
      primary: false,
    },
  ];
}
