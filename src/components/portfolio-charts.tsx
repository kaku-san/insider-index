import type { BacktestPoint, PortfolioHolding } from "@/lib/disclosures/types";
import { formatPct, formatUsd } from "@/lib/format";

const COLORS = [
  "#34d399",
  "#38bdf8",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#fb7185",
  "#2dd4bf",
];

function donutPath(start: number, slice: number, radius = 42, cx = 56, cy = 56): string {
  const toXY = (t: number) => {
    const angle = (t - 0.25) * Math.PI * 2;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  };
  const [x1, y1] = toXY(start);
  const [x2, y2] = toXY(start + slice);
  const large = slice > 0.5 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

export function PortfolioDonut({
  holdings,
  title,
}: {
  holdings: Pick<PortfolioHolding, "ticker" | "weightPct" | "xstockSymbol" | "valueUsd">[];
  title?: string;
}) {
  const slices = holdings.map((row, index) => {
    const start = holdings
      .slice(0, index)
      .reduce((total, holding) => total + holding.weightPct, 0);
    return { ...row, start, color: COLORS[index % COLORS.length] };
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <svg viewBox="0 0 112 112" className="size-36 shrink-0" role="img" aria-label={`${title ?? "Book"} allocation`}>
        <circle cx="56" cy="56" r="42" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="14" />
        {slices.map((slice) =>
          slice.weightPct <= 0 ? null : (
            <path
              key={slice.ticker}
              d={donutPath(slice.start, Math.max(slice.weightPct, 0.01))}
              fill="none"
              stroke={slice.color}
              strokeWidth="14"
              strokeLinecap="butt"
            />
          ),
        )}
        <text x="56" y="54" textAnchor="middle" className="fill-zinc-400" fontSize="8">
          {title ?? "Book"}
        </text>
        <text x="56" y="66" textAnchor="middle" className="fill-white" fontSize="10">
          {holdings.length} names
        </text>
      </svg>
      <div className="w-full space-y-2">
        {slices.map((slice) => (
          <div key={slice.ticker} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-300">
                <span className="mr-2 inline-block size-2 rounded-full" style={{ background: slice.color }} />
                {slice.xstockSymbol ?? slice.ticker}
              </span>
              <span className="text-zinc-400">
                {(slice.weightPct * 100).toFixed(0)}% · {formatUsd(slice.valueUsd)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(slice.weightPct * 100, 2)}%`, background: slice.color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EquityCurve({
  points,
  label,
}: {
  points: BacktestPoint[];
  label?: string;
}) {
  const width = 320;
  const height = 96;
  const min = Math.min(...points.map((point) => point.equity));
  const max = Math.max(...points.map((point) => point.equity));
  const span = Math.max(max - min, 1);
  const coords = points.map((point, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * width;
    const y = height - ((point.equity - min) / span) * (height - 8) - 4;
    return `${x},${y}`;
  });
  const last = points[points.length - 1];
  const first = points[0];
  const change = first ? (last.equity - first.equity) / first.equity : 0;
  const fillPoints = `0,${height} ${coords.join(" ")} ${width},${height}`;

  return (
    <div>
      <div className="mb-2 flex items-end justify-between text-sm">
        <div>
          <p className="text-zinc-400">{label ?? "Copy backtest"}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-600">Historical return</p>
        </div>
        <span className={`text-base font-semibold ${change >= 0 ? "metric-positive" : "metric-negative"}`}>
          {formatPct(change)}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full" role="img" aria-label={`${label ?? "Copy backtest"} ${formatPct(change)}`}>
        <defs>
          <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" x2={width} y1={height - 4} y2={height - 4} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 4" />
        <polygon fill="url(#equity-fill)" points={fillPoints} />
        <polyline
          fill="none"
          stroke="#34d399"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={coords.join(" ")}
        />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
        {points.map((point) => (
          <span key={point.label}>{point.label}</span>
        ))}
      </div>
    </div>
  );
}
