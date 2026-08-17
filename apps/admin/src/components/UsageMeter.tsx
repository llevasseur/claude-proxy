import type { UsagePaceStatus, UsageWindowMeter } from '@claude-proxy/core';
import { Fuel } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fmtInt } from '../format';

/**
 * Tone tracks the pace, not the fill level: a nearly-full bar is fine late in a
 * window, while a modest one early on can already be a problem.
 */
const TONE: Record<UsagePaceStatus, string> = {
  safe: 'good',
  'on-pace': 'signal',
  aggressive: 'warn',
  exhausted: 'bad',
};

const STATUS_LABEL: Record<UsagePaceStatus, string> = {
  safe: 'Within limits',
  'on-pace': 'Near limit',
  aggressive: 'Too aggressive',
  exhausted: 'Limit reached',
};

/**
 * An inferred ceiling can speak only to the busiest window on record, not the limit.
 * `aggressive` projects *past* that record by reset; `on-pace` does not.
 */
const LEARNED_STATUS_LABEL: Record<UsagePaceStatus, string> = {
  safe: 'Below record',
  'on-pace': 'Near record',
  aggressive: 'Passing record',
  exhausted: 'New record',
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
  const time = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  if (d.getTime() - now.getTime() <= DAY_QUALIFIER_MS) return time;
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
  return `${day} ${time}`;
};

/* Fuel-gauge geometry: a half-moon over the top — the arc runs from 150°
 * clockwise to 30° in math angles, so E sits at the left end, F at the right,
 * and the needle crests 12 o'clock at half a tank. The needle pivots on
 * (100, 104) in a 200×136 viewBox, and the low-fuel telltale sits in the middle
 * of the dial face, off by default. In the clockwise-from-12-o'clock frame used
 * below, that is a start of -60° and a sweep of 120°. */
const GAUGE_CX = 100;
const GAUGE_CY = 104;
const GAUGE_R = 78;
const GAUGE_START = -60;
const GAUGE_SWEEP = 120;
/** Below this much allowance left, the low-fuel lamp lights. */
const LOW_FUEL_PCT = 10;

/** A point on the dial, `deg` measured clockwise from 12 o'clock. */
function polar(deg: number, r: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: GAUGE_CX + r * Math.sin(rad), y: GAUGE_CY - r * Math.cos(rad) };
}

/** Needle angle for a fraction of allowance left: 0 → E on the left, 1 → F on the right. */
function angleAt(left: number): number {
  return GAUGE_START + GAUGE_SWEEP * left;
}

function arcPath(fromDeg: number, toDeg: number, r: number): string {
  const a = polar(fromDeg, r);
  const b = polar(toDeg, r);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/** A radial tick from `r0` out to `r1`. */
function Tick({ left, r0, r1, className }: { left: number; r0: number; r1: number; className?: string }) {
  const deg = angleAt(left);
  const a = polar(deg, r0);
  const b = polar(deg, r1);
  return <line x1={a.x.toFixed(2)} y1={a.y.toFixed(2)} x2={b.x.toFixed(2)} y2={b.y.toFixed(2)} className={className} />;
}

/**
 * The dial: track, low-fuel zone, ticks, E/F, a ghost tick where the current
 * pace lands by reset, and the needle. The needle's angle rides a CSS custom
 * property so the sheet can transition it and `@starting-style` can sweep it in
 * from E on ignition.
 */
function FuelGauge({
  left,
  projectedLeft,
  low,
  label,
}: {
  left: number;
  projectedLeft: number | null;
  low: boolean;
  label: string;
}) {
  const leftPct = Math.round(left * 100);
  const needle = { '--needle': `${angleAt(left)}deg` } as CSSProperties;
  const eLabel = polar(angleAt(0), GAUGE_R - 22);
  const fLabel = polar(angleAt(1), GAUGE_R - 22);

  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot be drawn as this dial; the role carries the same semantics onto the SVG
    <svg
      className='gauge'
      viewBox='0 0 200 136'
      role='meter'
      aria-valuenow={leftPct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${leftPct}% of allowance left`}
      aria-label={`${label} allowance left`}>
      <path className='gauge-track' d={arcPath(angleAt(0), angleAt(1), GAUGE_R)} />
      <path className='gauge-zone-low' d={arcPath(angleAt(0), angleAt(LOW_FUEL_PCT / 100), GAUGE_R)} />
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <Tick key={f} left={f} r0={GAUGE_R - 12} r1={GAUGE_R - 4} className='gauge-tick' />
      ))}
      <text className='gauge-letter' x={eLabel.x.toFixed(2)} y={eLabel.y.toFixed(2)}>
        E
      </text>
      <text className='gauge-letter' x={fLabel.x.toFixed(2)} y={fLabel.y.toFixed(2)}>
        F
      </text>
      {/* Where this pace lands by the reset — only drawn when it is below the needle. */}
      {projectedLeft != null && projectedLeft < left && (
        <Tick left={projectedLeft} r0={GAUGE_R - 16} r1={GAUGE_R - 2} className='gauge-ghost' />
      )}
      <g className='gauge-needle' style={needle}>
        <polygon points='97,112 100,36 103,112' />
      </g>
      <circle className='gauge-hub' cx={GAUGE_CX} cy={GAUGE_CY} r={6} />
      {/* The low-fuel telltale, centred in the dial face like a cluster lamp. */}
      <Fuel
        x={92}
        y={114}
        width={16}
        height={16}
        className={`gauge-lamp${low ? ' is-low' : ''}`}
        aria-hidden={!low}
        aria-label={low ? 'Low allowance' : undefined}
      />
    </svg>
  );
}

/** One window's allowance as a fuel gauge: how much is left, and the pace read. */
export function UsageMeter({ meter: w }: { meter: UsageWindowMeter }) {
  const tone = TONE[w.pace.status];
  const utilPct = w.utilization * 100;
  const remaining = Math.max(0, 100 - utilPct);
  const left = Math.min(1, Math.max(0, 1 - w.utilization));
  const projectedLeft = w.pace.projected == null ? null : Math.min(1, Math.max(0, 1 - w.pace.projected));
  const low = remaining <= LOW_FUEL_PCT;

  return (
    <div className={`card usage-meter tone-${tone}`}>
      <div className='usage-meter-head'>
        <span className='stat-label'>{w.label}</span>
        <span className={`usage-chip ${tone}`}>{(w.learned ? LEARNED_STATUS_LABEL : STATUS_LABEL)[w.pace.status]}</span>
      </div>

      <div className='gauge-cluster'>
        <FuelGauge left={left} projectedLeft={projectedLeft} low={low} label={w.label} />
        <div className='gauge-readout'>
          <span className='usage-meter-value'>
            {remaining < 10 ? remaining.toFixed(1) : Math.round(remaining)}
            <span className='usage-meter-unit'>% left</span>
          </span>
        </div>
      </div>

      <div className='usage-meter-foot'>
        {w.resetsAt ? (
          <span className='muted'>resets {resetClock(w.resetsAt)}</span>
        ) : w.coverage < 0.95 ? (
          // The count can only read low when the logs don't span the window.
          <span className='usage-partial' title='Older logs have rotated out — this is a floor, not a total'>
            partial · {Math.round(w.coverage * 100)}% of window
          </span>
        ) : w.learned ? (
          // The denominator is a floor too, so this reads high rather than low.
          <span
            className='usage-learned'
            title={`No allowance was reported or configured, so this is measured against the busiest of ${w.learned.windows} completed windows on record. The real ceiling can only be higher, so the percentage overstates how close you are.`}>
            inferred · {w.learned.windows} windows seen
          </span>
        ) : (
          <span className='muted'>trailing window</span>
        )}
        {(w.source === 'estimated' || w.source === 'learned') && w.usedUnits != null && w.limitUnits != null ? (
          <span className='muted'>
            ~{fmtInt(w.usedUnits)} / {fmtInt(w.limitUnits)} units
          </span>
        ) : (
          <span className='muted'>
            {w.source === 'live' || w.source === 'headers'
              ? 'reported by Anthropic'
              : w.source === 'learned'
                ? 'inferred'
                : 'estimated'}
          </span>
        )}
      </div>

      <p className='usage-blurb'>{w.pace.blurb}</p>
    </div>
  );
}
