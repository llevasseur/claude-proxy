import { deltaLabel, deltaTone } from "../format";

export interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  /** Day-over-day delta %, if available. */
  deltaPct?: number;
  /** Whether an increase is good (e.g. cache-hit) or bad (e.g. cost). */
  increaseIsBad?: boolean;
}

export function StatCard({ label, value, sub, deltaPct, increaseIsBad = true }: StatCardProps) {
  const tone = deltaPct === undefined ? null : deltaTone(deltaPct);
  const good = tone === "flat" ? "flat" : (tone === "up") === increaseIsBad ? "bad" : "good";
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">
        {sub && <span className="muted">{sub}</span>}
        {deltaPct !== undefined && tone !== "flat" && <span className={`delta ${good}`}>{deltaLabel(deltaPct)}</span>}
      </div>
    </div>
  );
}
