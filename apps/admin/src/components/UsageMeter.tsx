import type { UsagePaceStatus, UsageWindowMeter } from "@claude-proxy/core";
import { fmtInt } from "../format";

/**
 * Tone tracks the pace, not the fill level: a nearly-full bar is fine late in a
 * window, while a modest one early on can already be a problem.
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

/**
 * An inferred ceiling can speak only to the busiest window on record, not the limit.
 * `aggressive` projects *past* that record by reset; `on-pace` does not.
 */
const LEARNED_STATUS_LABEL: Record<UsagePaceStatus, string> = {
  safe: "Below record",
  "on-pace": "Near record",
  aggressive: "Passing record",
  exhausted: "New record",
};

/** Beyond this the weekday is needed to say which day's reset is meant. */
const DAY_QUALIFIER_MS = 12 * 60 * 60 * 1000;

/**
 * Local 24-hour clock time for a reset instant, prefixed with the weekday once the
 * reset is far enough out that the time alone is ambiguous — a weekly window resets
 * days away.
 */
const resetClock = (iso: string, now: Date = new Date()): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  if (d.getTime() - now.getTime() <= DAY_QUALIFIER_MS) return time;
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(d);
  return `${day} ${time}`;
};

/** One window's allowance: a bar, the headline number, and the pace read. */
export function UsageMeter({ meter: w }: { meter: UsageWindowMeter }) {
  const tone = TONE[w.pace.status];
  const utilPct = w.utilization * 100;
  // Capped so an over-budget estimate can't overflow the track; the headline
  // number still reports the true figure.
  const fill = Math.min(100, Math.max(0, utilPct));
  const projected = w.pace.projected == null ? null : Math.min(100, w.pace.projected * 100);

  return (
    <div className={`card usage-meter tone-${tone}`}>
      <div className="usage-meter-head">
        <span className="stat-label">{w.label}</span>
        <span className={`usage-chip ${tone}`}>
          {(w.learned ? LEARNED_STATUS_LABEL : STATUS_LABEL)[w.pace.status]}
        </span>
      </div>

      <div className="usage-meter-value">
        {utilPct < 10 ? utilPct.toFixed(1) : Math.round(utilPct)}
        <span className="usage-meter-unit">%</span>
      </div>

      <div
        className="usage-bar"
        role="meter"
        // An over-budget estimate exceeds 100%, which `aria-valuenow` may not; the
        // true figure rides along in `aria-valuetext`.
        aria-valuenow={Math.round(fill)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${Math.round(utilPct)}% used`}
        aria-label={`${w.label} allowance used`}
      >
        <div className="usage-bar-fill" style={{ width: `${fill}%` }} />
        {/* Projection: where this rate lands by the reset. */}
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
        ) : w.learned ? (
          // The denominator is a floor too, so this reads high rather than low.
          <span
            className="usage-learned"
            title={`No allowance was reported or configured, so this is measured against the busiest of ${w.learned.windows} completed windows on record. The real ceiling can only be higher, so the percentage overstates how close you are.`}
          >
            inferred · {w.learned.windows} windows seen
          </span>
        ) : (
          <span className="muted">trailing window</span>
        )}
        {(w.source === "estimated" || w.source === "learned") && w.usedUnits != null && w.limitUnits != null ? (
          <span className="muted">
            ~{fmtInt(w.usedUnits)} / {fmtInt(w.limitUnits)} units
          </span>
        ) : (
          <span className="muted">
            {w.source === "live" || w.source === "headers"
              ? "reported by Anthropic"
              : w.source === "learned"
                ? "inferred"
                : "estimated"}
          </span>
        )}
      </div>

      <p className="usage-blurb">{w.pace.blurb}</p>
    </div>
  );
}
