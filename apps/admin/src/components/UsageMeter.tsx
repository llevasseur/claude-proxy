import type { UsagePaceStatus, UsageWindowMeter } from "@claude-proxy/core";
import { fmtInt } from "../format";

/**
 * Meter tone tracks the *pace*, not the fill level — a bar can be nearly full and
 * still be fine late in a window, while a modest bar early on can already be a
 * problem. Mapped onto the palette's existing semantics so it reads the same way
 * as every other status colour in the dashboard.
 */
const TONE: Record<UsagePaceStatus, string> = {
  safe: "good",
  "on-pace": "signal",
  aggressive: "warn",
  exhausted: "bad",
};

const STATUS_LABEL: Record<UsagePaceStatus, string> = {
  safe: "Within limits",
  "on-pace": "Near limit",
  aggressive: "Too aggressive",
  exhausted: "Limit reached",
};

/** Local clock time for a reset instant, e.g. `18:20`. */
const resetClock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
};

/** One window's allowance: a bar, the headline number, and the pace read. */
export function UsageMeter({ meter: w }: { meter: UsageWindowMeter }) {
  const tone = TONE[w.pace.status];
  const utilPct = w.utilization * 100;
  // The bar caps at 100% so an over-budget estimate can't overflow the track;
  // the headline number still reports the true figure.
  const fill = Math.min(100, Math.max(0, utilPct));
  const projected = w.pace.projected == null ? null : Math.min(100, w.pace.projected * 100);

  return (
    <div className={`card usage-meter tone-${tone}`}>
      <div className="usage-meter-head">
        <span className="stat-label">{w.label}</span>
        <span className={`usage-chip ${tone}`}>{STATUS_LABEL[w.pace.status]}</span>
      </div>

      <div className="usage-meter-value">
        {utilPct < 10 ? utilPct.toFixed(1) : Math.round(utilPct)}
        <span className="usage-meter-unit">%</span>
      </div>

      <div
        className="usage-bar"
        role="meter"
        aria-valuenow={Math.round(utilPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${w.label} allowance used`}
      >
        <div className="usage-bar-fill" style={{ width: `${fill}%` }} />
        {/* Where this rate lands by the reset — the thing to steer by. */}
        {projected != null && projected > fill && (
          <div className="usage-bar-projected" style={{ width: `${projected}%` }} title="Projected by reset" />
        )}
      </div>

      <div className="usage-meter-foot">
        {w.resetsAt ? (
          <span className="muted">resets {resetClock(w.resetsAt)}</span>
        ) : w.coverage < 0.95 ? (
          // The count can only read low when the logs don't span the window.
          <span className="usage-partial" title="Older logs have rotated out — this is a floor, not a total">
            partial · {Math.round(w.coverage * 100)}% of window
          </span>
        ) : (
          <span className="muted">trailing window</span>
        )}
        {w.source === "estimated" && w.usedUnits != null && w.limitUnits != null ? (
          <span className="muted">
            ~{fmtInt(w.usedUnits)} / {fmtInt(w.limitUnits)} units
          </span>
        ) : (
          <span className="muted">{w.source === "headers" ? "reported by Anthropic" : "estimated"}</span>
        )}
      </div>

      <p className="usage-blurb">{w.pace.blurb}</p>
    </div>
  );
}
