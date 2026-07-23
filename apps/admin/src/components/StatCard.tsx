import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Sparkline, type SparkPoint } from "./Sparkline";
import { deltaLabel, deltaTone } from "../format";

/** Per-day series and how to render it, for the mini chart and popover. */
export interface StatSpark {
  points: SparkPoint[];
  /** Line colour (a CSS custom property). */
  color: string;
  format: (n: number) => string;
}

export interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  /** Day-over-day delta %, if available. */
  deltaPct?: number;
  /** Whether an increase is good (e.g. cache-hit) or bad (e.g. cost). */
  increaseIsBad?: boolean;
  /** Metric slug — makes the whole card a link to `/trends/$metric`. */
  metric?: string;
  /** Per-day history: renders a sparkline and a hover popover of values. */
  spark?: StatSpark;
}

export function StatCard({ label, value, sub, deltaPct, increaseIsBad = true, metric, spark }: StatCardProps) {
  const tone = deltaPct === undefined ? null : deltaTone(deltaPct);
  const good = tone === "flat" ? "flat" : (tone === "up") === increaseIsBad ? "bad" : "good";

  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">
        {sub && <span className="muted">{sub}</span>}
        {deltaPct !== undefined && tone !== "flat" && <span className={`delta ${good}`}>{deltaLabel(deltaPct)}</span>}
      </div>
      {spark && spark.points.length > 0 && (
        <>
          <Sparkline points={spark.points} color={spark.color} />
          <StatPopover label={label} spark={spark} />
        </>
      )}
    </>
  );

  if (metric) {
    return (
      <Link to="/trends/$metric" params={{ metric }} className="card stat stat-link">
        {body}
      </Link>
    );
  }
  return <div className="card stat">{body}</div>;
}

/** Hover panel listing each day's value, newest first. */
function StatPopover({ label, spark }: { label: string; spark: StatSpark }): ReactNode {
  const rows = [...spark.points].reverse();
  return (
    <div className="stat-popover" role="tooltip">
      <div className="stat-popover-head">{label} · by day</div>
      <ul className="stat-popover-list">
        {rows.map((p) => (
          <li key={p.date}>
            <span className="stat-popover-date">{p.date.slice(5)}</span>
            <span className="stat-popover-value">{spark.format(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
