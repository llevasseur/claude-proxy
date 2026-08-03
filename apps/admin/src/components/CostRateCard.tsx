import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { costRatePoints, isPartialDay, summarizeCostRate, type CostRatePoint, type UsageDigest } from "@claude-proxy/core";
import { deltaLabel, deltaTone, fmtInt, fmtUsd, fmtUsdPerMTok, fmtTokensShort } from "../format";
import { Skeleton, SkeletonCard } from "./Skeleton";

/** Plot height, in px. Matched by the skeleton so the card does not resize on load. */
export const COST_RATE_CHART_HEIGHT = 260;

/**
 * Colour for the newest day. Deliberately not `--accent`, which resolves to the
 * same teal as `--signal`: the two series have to differ by hue and not only by
 * dot size, or the legend names a distinction the plot never draws.
 */
const TODAY_COLOR = "var(--amber)";

/** Legend entries, in the order they are drawn. */
const LEGEND = [
  { name: "Earlier days", color: "var(--accent)" },
  { name: "Today", color: TODAY_COLOR },
  { name: "Median rate", color: "var(--muted)" },
];

/**
 * Spend against volume, one dot per day. The dashed line is the median $/MTok of
 * the earlier days, so a dot below it bought its tokens more cheaply than usual
 * and a dot above it paid more — a comparison the raw cost and token charts this
 * replaced could not make, because both of those move with volume alone.
 */
export function CostRateCard({ digests }: { digests: UsageDigest[] }) {
  const points = costRatePoints(digests);
  const summary = summarizeCostRate(digests);
  const today = summary.today;
  const prior = points.filter((p) => p.date !== today?.date);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Cost per token</h2>
        <span className="range">{rangeLabel(points)}</span>
      </div>

      <Verdict summary={summary} priorDays={prior.length} />

      {points.length === 0 ? (
        <div className="empty">No tokens captured in this window.</div>
      ) : (
        <>
          <CostRateChart prior={prior} today={today} baseline={summary.baseline} />
          <div className="chartlegend">
            {LEGEND.map((l) => (
              <span className="chartlegend-item" key={l.name}>
                <span className="chartlegend-swatch" style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const rangeLabel = (points: CostRatePoint[]): string => {
  const first = points.at(0);
  const last = points.at(-1);
  if (!first || !last) return "—";
  return first.date === last.date ? first.date : `${first.date} → ${last.date}`;
};

/**
 * The question stated in words above the plot: what today cost, what that works
 * out to per token, and whether that beats the days before it. Rendered even
 * when there is nothing to compare against, so the card keeps its height.
 */
function Verdict({ summary, priorDays }: { summary: ReturnType<typeof summarizeCostRate>; priorDays: number }) {
  const { today, baseline, deltaPct } = summary;
  if (!today) {
    return <div className="trend-compare muted">No tokens moved yet on the newest day in this window.</div>;
  }

  const tone = deltaPct === null ? "flat" : deltaTone(deltaPct);
  // A rising price per token is always the regression, so `up` is the bad tone.
  const toneClass = tone === "flat" ? "flat" : tone === "up" ? "bad" : "good";

  return (
    <div className="trend-compare">
      <span className="trend-compare-value">
        {today.date}: {fmtUsd(today.cost)}
      </span>
      {isPartialDay(today.date) && <span className="muted"> (so far today)</span>}{" "}
      <span className="muted">· {fmtUsdPerMTok(today.rate)} across {fmtInt(today.tokens)} tokens</span>{" "}
      {baseline === null || deltaPct === null ? (
        <span className="muted">— no earlier day in this window to compare against.</span>
      ) : tone === "flat" ? (
        <span className="muted">
          — level with the {fmtUsdPerMTok(baseline)} median of the {priorDays} day
          {priorDays === 1 ? "" : "s"} before it.
        </span>
      ) : (
        <>
          <span className={`delta ${toneClass}`}>{deltaLabel(deltaPct)}</span>{" "}
          <span className="muted">
            {tone === "up" ? "above" : "below"} the {fmtUsdPerMTok(baseline)} median of the {priorDays} day
            {priorDays === 1 ? "" : "s"} before it.
          </span>
        </>
      )}
    </div>
  );
}

/** `fmtUsd` gives sub-dollar values three decimals, which renders the zero tick as `$0.000`. */
const fmtAxisUsd = (n: number): string => (n === 0 ? "$0" : fmtUsd(n));

/** Up to the next quarter of a power of ten — 465.2M becomes 500M, 12.1M becomes 12.5M. */
function roundUp(n: number): number {
  if (n <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(n)) / 4;
  return Math.ceil(n / step) * step;
}

interface CostRateChartProps {
  prior: CostRatePoint[];
  today: CostRatePoint | null;
  baseline: number | null;
}

/**
 * Volume on x, spend on y. A day's slope from the origin is its price per token,
 * which is what makes a huge day and a small one comparable at all — so the
 * baseline is drawn as a line through the origin rather than a horizontal rule.
 */
function CostRateChart({ prior, today, baseline }: CostRateChartProps) {
  // `z` drives dot area through the shared ZAxis; today is drawn at the top of
  // the range so it reads as the subject of the card rather than one more day.
  const priorRows = prior.map((p) => ({ ...p, z: 1 }));
  const todayRows = today ? [{ ...today, z: 3 }] : [];
  const days = [...prior, ...(today ? [today] : [])];
  // Headroom so the largest day is not drawn on the frame, rounded up to a round
  // number: recharts labels the domain edge, and a raw 1.08x turns the last tick
  // into something like `465.2M` sitting a hair away from the one before it.
  const domainMax = roundUp(Math.max(...days.map((p) => p.tokens)) * 1.08);
  // Both axes are fixed rather than left to `auto`, because the baseline below is
  // clamped against this maximum and has to be measured against the same number
  // the axis is drawn from.
  const costMax = roundUp(Math.max(...days.map((p) => p.cost)) * 1.08);
  // Where the median-rate line leaves the plot. It exits through the top rather
  // than the right whenever the window's priciest day out-slopes the median, and
  // recharts silently drops a `ReferenceLine` whose segment runs outside the
  // domain — so the endpoint is clamped to whichever edge it reaches first.
  const lineEndX = baseline === null ? 0 : Math.min(domainMax, (costMax * 1_000_000) / baseline);

  return (
    <div style={{ height: COST_RATE_CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 14, bottom: 2, left: 2 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="tokens"
            name="Tokens"
            domain={[0, domainMax]}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtTokensShort}
          />
          <YAxis
            type="number"
            dataKey="cost"
            name="Est. cost"
            domain={[0, costMax]}
            width={56}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtAxisUsd}
          />
          <ZAxis type="number" dataKey="z" domain={[1, 3]} range={[55, 190]} />
          {baseline !== null && (
            <ReferenceLine
              stroke="var(--muted)"
              strokeDasharray="5 4"
              segment={[
                { x: 0, y: 0 },
                { x: lineEndX, y: (lineEndX * baseline) / 1_000_000 },
              ]}
            />
          )}
          <Tooltip cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }} content={<CostRateTooltip />} />
          <Scatter data={priorRows} fill="var(--accent)" isAnimationActive={false} />
          {todayRows.length > 0 && <Scatter data={todayRows} fill={TODAY_COLOR} isAnimationActive={false} />}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

interface CostRateTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: CostRatePoint }>;
}

/** Card-style tooltip matching the admin's panels rather than recharts' default. */
function CostRateTooltip({ active, payload }: CostRateTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="charttip">
      <div className="charttip-label">{point.date}</div>
      <div className="charttip-row">
        <span className="charttip-name">Tokens</span>
        <span className="charttip-value">{fmtInt(point.tokens)}</span>
      </div>
      <div className="charttip-row">
        <span className="charttip-name">Est. cost</span>
        <span className="charttip-value">{fmtUsd(point.cost)}</span>
      </div>
      <div className="charttip-row">
        <span className="charttip-name">Rate</span>
        <span className="charttip-value">{fmtUsdPerMTok(point.rate)}</span>
      </div>
    </div>
  );
}

/**
 * The card at its loaded size. Built out rather than delegated to
 * `SkeletonChartCard`, which reserves a plot and a legend but not the verdict
 * line this card carries between them.
 */
export function CostRateSkeleton({ days }: { days: number }) {
  // Deterministic sawtooth, so the bars don't flicker between renders.
  const heights = Array.from({ length: days }, (_, i) => 34 + ((i * 37) % 61));

  return (
    <SkeletonCard title="Cost per token">
      <div className="trend-compare" aria-hidden>
        <Skeleton w="72%" />
      </div>
      <div className="skeleton-chart" style={{ height: COST_RATE_CHART_HEIGHT }} aria-hidden>
        {heights.map((h, i) => (
          <span className="skeleton skeleton-bar" key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="chartlegend" aria-hidden>
        {LEGEND.map((l) => (
          <span className="chartlegend-item" key={l.name}>
            <Skeleton w="4.5rem" />
          </span>
        ))}
      </div>
    </SkeletonCard>
  );
}
