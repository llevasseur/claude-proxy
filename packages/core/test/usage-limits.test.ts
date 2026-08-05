import { describe, expect, it } from 'vitest';
import {
  buildUsageLimits,
  CACHE_READ_COST_WEIGHT,
  CACHE_READ_METERING_WEIGHT,
  fmtDuration,
  learnCeilings,
  usageUnits,
  windowOfHeader,
} from '../src/usage-limits.js';

const NOW = new Date('2026-07-30T18:00:00.000Z');

/** A structurally valid sidecar; only the fields a test cares about need naming. */
function sidecar(over: {
  at?: string;
  model?: string;
  tokens?: Partial<{ input: number; output: number; cacheRead: number; cacheCreation: number; realInput: number }>;
  rateLimit?: Record<string, string>;
}) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0, ...(over.tokens ?? {}) };
  const base: Record<string, unknown> = {
    timestamp: over.at ?? NOW.toISOString(),
    model: over.model ?? 'claude-sonnet-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: t,
    request: { toolCount: 0, toolsBytes: 0, systemBytes: 0, totalBytes: 0 },
    tools: [],
  };
  if (over.rateLimit) base.rateLimit = over.rateLimit;
  return base;
}

/** Minutes before NOW, as an ISO stamp. */
const agoMin = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();
/** An ISO stamp `m` minutes after NOW — for reset instants. */
const inMin = (m: number): string => new Date(NOW.getTime() + m * 60_000).toISOString();

const only = (s: ReturnType<typeof buildUsageLimits>, kind: string) => {
  const w = s.windows.find((x) => x.kind === kind);
  if (!w) throw new Error(`no ${kind} window in [${s.windows.map((x) => x.kind).join(', ')}]`);
  return w;
};

describe('windowOfHeader', () => {
  it('classifies the unified window headers', () => {
    expect(windowOfHeader('anthropic-ratelimit-unified-5h-remaining')).toBe('5h');
    expect(windowOfHeader('anthropic-ratelimit-unified-7d-remaining')).toBe('week');
    expect(windowOfHeader('anthropic-ratelimit-unified-week-limit')).toBe('week');
  });

  it('routes the top-tier weekly window to its own meter', () => {
    // Anthropic has named this window after Opus; Fable is the current top tier.
    expect(windowOfHeader('anthropic-ratelimit-unified-7d-opus-remaining')).toBe('weekFable');
    expect(windowOfHeader('anthropic-ratelimit-unified-7d-fable-remaining')).toBe('weekFable');
  });

  it('ignores headers that name no window', () => {
    expect(windowOfHeader('anthropic-ratelimit-requests-remaining')).toBeNull();
    expect(windowOfHeader('content-type')).toBeNull();
  });
});

describe('usageUnits', () => {
  it('meters cache reads at the metering weight, not the cost one, and ignores realInput', () => {
    // realInput double-counts input + cacheRead + cacheCreation, so it must not add.
    // 10k cache reads meter as 200 units, not the 1000 the cost ratio would give.
    expect(usageUnits({ input: 1000, output: 500, cacheRead: 10_000, cacheCreation: 0, realInput: 11_000 })).toBe(1700);
    expect(CACHE_READ_METERING_WEIGHT).toBeLessThan(CACHE_READ_COST_WEIGHT);
  });
});

/**
 * The four completed 5-hour windows whose sidecars carry an
 * `anthropic-ratelimit-unified-5h-utilization` header — every one on record, from
 * 2026-08-04 and 2026-08-05. `util` is Anthropic's own reading at the last request
 * of the window; the token counts are every request from the window's opening
 * instant (reset − 5h) up to that reading.
 *
 * Anthropic never publishes the allowance, so these four are the only measurement
 * of the metering unit there is.
 */
const OBSERVED_5H_WINDOWS = [
  {
    opened: '2026-08-04T12:20:00Z',
    util: 0.82,
    input: 761_395,
    output: 1_225_759,
    cacheRead: 355_659_610,
    cacheCreation: 7_274_165,
  },
  {
    opened: '2026-08-04T17:20:00Z',
    util: 0.43,
    input: 505_140,
    output: 667_994,
    cacheRead: 155_298_357,
    cacheCreation: 3_262_877,
  },
  {
    opened: '2026-08-05T12:50:00Z',
    util: 0.93,
    input: 3_029_783,
    output: 1_215_817,
    cacheRead: 292_318_446,
    cacheCreation: 7_182_611,
  },
  {
    opened: '2026-08-05T17:50:00Z',
    util: 0.43,
    input: 373_961,
    output: 627_085,
    cacheRead: 165_036_674,
    cacheCreation: 3_738_450,
  },
] as const;

/** Widest departure from the mean, as a fraction of it. */
function spread(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.max(...values.map((v) => Math.abs(v - mean) / mean));
}

/** The allowance each window implies, at a given cache-read weight. */
const impliedCeilings = (weight: number): number[] =>
  OBSERVED_5H_WINDOWS.map((w) => (w.input + w.output + w.cacheCreation + w.cacheRead * weight) / w.util);

describe('the cache-read metering weight, against observed windows', () => {
  it('is the weight the four observed windows agree on', () => {
    // One allowance produced all four readings, so the implied ceilings must match.
    expect(spread(impliedCeilings(CACHE_READ_METERING_WEIGHT))).toBeLessThan(0.07);
  });

  it('does not agree at the cost weight, which is the defect', () => {
    // The billing ratio spreads the same four windows over twice the range.
    expect(spread(impliedCeilings(CACHE_READ_COST_WEIGHT))).toBeGreaterThan(0.12);
    expect(spread(impliedCeilings(CACHE_READ_COST_WEIGHT))).toBeGreaterThan(
      spread(impliedCeilings(CACHE_READ_METERING_WEIGHT)),
    );
  });

  it('sits in the fitted band rather than on an arbitrary round number', () => {
    // The fit is flat across 0.015–0.02 and worse either side; 0.02 is its
    // conservative end, reading usage high.
    expect(CACHE_READ_METERING_WEIGHT).toBeGreaterThanOrEqual(0.015);
    expect(CACHE_READ_METERING_WEIGHT).toBeLessThanOrEqual(0.02);
    for (const worse of [0.005, 0.05, 0.1]) {
      expect(spread(impliedCeilings(worse))).toBeGreaterThan(spread(impliedCeilings(CACHE_READ_METERING_WEIGHT)));
    }
  });

  it('counts a whole observed window the same way usageUnits does', () => {
    const w = OBSERVED_5H_WINDOWS[0]!;
    const counted = usageUnits({ ...w, realInput: w.input + w.cacheRead + w.cacheCreation });
    expect(counted).toBeCloseTo(w.input + w.output + w.cacheCreation + w.cacheRead * CACHE_READ_METERING_WEIGHT, 6);
    // ~16.4M units against 82% implies a ~20M 5-hour ceiling, not the ~55M the
    // cost weight reports for the same traffic.
    expect(counted / w.util).toBeGreaterThan(15e6);
    expect(counted / w.util).toBeLessThan(25e6);
  });
});

describe('fmtDuration', () => {
  it('renders at blurb width', () => {
    expect(fmtDuration(45 * 60_000)).toBe('45m');
    expect(fmtDuration(3 * 3600_000 + 40 * 60_000)).toBe('3h 40m');
    expect(fmtDuration(2 * 86_400_000 + 4 * 3600_000)).toBe('2d 4h');
  });
});

describe('buildUsageLimits — from captured headers', () => {
  it('derives utilization from limit and remaining, and reads the reset instant', () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '100',
            'anthropic-ratelimit-unified-5h-remaining': '90',
            'anthropic-ratelimit-unified-5h-reset': inMin(60),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, '5h');
    expect(w.source).toBe('headers');
    expect(w.utilization).toBeCloseTo(0.1);
    expect(w.resetsAt).toBe(inMin(60));
    expect(snap.meta.fromHeaders).toBe(1);
  });

  it('flags a rate that would exhaust the window before it resets', () => {
    // 80% spent with 1h of a 5h window left — 80% elapsed, so it lands at ~100%.
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '100',
            'anthropic-ratelimit-unified-5h-remaining': '20',
            'anthropic-ratelimit-unified-5h-reset': inMin(60),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, '5h');
    expect(w.pace.status).toBe('aggressive');
    expect(w.pace.projected).toBeCloseTo(1);
    expect(w.pace.blurb).toMatch(/faster than it refills/i);
  });

  it('calls a rate safe when it projects well under the ceiling', () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '100',
            'anthropic-ratelimit-unified-5h-remaining': '90',
            'anthropic-ratelimit-unified-5h-reset': inMin(60),
          },
        }),
      ],
      { now: NOW },
    );
    expect(only(snap, '5h').pace.status).toBe('safe');
  });

  it('warns when the projection lands near but under the ceiling', () => {
    // 50% spent with 2h of 5h left → 60% elapsed → projects ~83%.
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '100',
            'anthropic-ratelimit-unified-5h-remaining': '50',
            'anthropic-ratelimit-unified-5h-reset': inMin(120),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, '5h');
    expect(w.pace.status).toBe('on-pace');
    expect(w.pace.projected).toBeCloseTo(0.8333, 3);
  });

  it('reports an emptied allowance as exhausted', () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '100',
            'anthropic-ratelimit-unified-5h-remaining': '0',
            'anthropic-ratelimit-unified-5h-reset': inMin(30),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, '5h');
    expect(w.pace.status).toBe('exhausted');
    // Anthropic reported this one, so the allowance really does bind.
    expect(w.pace.blurb).toMatch(/resets in 30m/);
    expect(w.pace.blurb).toMatch(/refused/i);
  });

  it('accepts a utilization header as a fraction or a percentage', () => {
    const frac = buildUsageLimits([sidecar({ rateLimit: { 'anthropic-ratelimit-unified-5h-utilization': '0.42' } })], {
      now: NOW,
    });
    expect(only(frac, '5h').utilization).toBeCloseTo(0.42);

    const percent = buildUsageLimits([sidecar({ rateLimit: { 'anthropic-ratelimit-unified-5h-utilization': '42' } })], {
      now: NOW,
    });
    expect(only(percent, '5h').utilization).toBeCloseTo(0.42);
  });

  it('reads a reset given as epoch seconds or as seconds-from-now', () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 3600;
    const asEpoch = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '10',
            'anthropic-ratelimit-unified-5h-remaining': '5',
            'anthropic-ratelimit-unified-5h-reset': String(epoch),
          },
        }),
      ],
      { now: NOW },
    );
    expect(only(asEpoch, '5h').resetsAt).toBe(inMin(60));

    const asDelta = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-limit': '10',
            'anthropic-ratelimit-unified-5h-remaining': '5',
            'anthropic-ratelimit-unified-5h-reset': '3600',
          },
        }),
      ],
      { now: NOW },
    );
    expect(only(asDelta, '5h').resetsAt).toBe(inMin(60));
  });

  it("takes the newest request's headers, not an older reading", () => {
    const snap = buildUsageLimits(
      [
        sidecar({ at: agoMin(90), rateLimit: { 'anthropic-ratelimit-unified-5h-utilization': '0.10' } }),
        sidecar({ at: agoMin(5), rateLimit: { 'anthropic-ratelimit-unified-5h-utilization': '0.70' } }),
      ],
      { now: NOW },
    );
    expect(only(snap, '5h').utilization).toBeCloseTo(0.7);
  });

  it('surfaces all three windows when the headers cover them', () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            'anthropic-ratelimit-unified-5h-utilization': '0.2',
            'anthropic-ratelimit-unified-7d-utilization': '0.4',
            'anthropic-ratelimit-unified-7d-opus-utilization': '0.6',
          },
        }),
      ],
      { now: NOW },
    );
    expect(snap.windows.map((w) => w.kind)).toEqual(['5h', 'week', 'weekFable']);
  });
});

describe('buildUsageLimits — estimated from logged tokens', () => {
  const tokens = { input: 1000, output: 500, cacheRead: 50_000 }; // 2500 units each

  it('counts weighted units in the trailing window against the configured ceiling', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens }), sidecar({ at: agoMin(10), tokens })], {
      now: NOW,
      limits: { '5h': 10_000 },
    });
    const w = only(snap, '5h');
    expect(w.source).toBe('estimated');
    expect(w.usedUnits).toBe(5000);
    expect(w.limitUnits).toBe(10_000);
    expect(w.utilization).toBeCloseTo(0.5);
    expect(w.resetsAt).toBeNull();
    expect(w.pace.blurb).toMatch(/trailing/i);
  });

  it('leaves requests outside the window out of the count', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(6 * 60), tokens }), sidecar({ at: agoMin(10), tokens })], {
      now: NOW,
      limits: { '5h': 10_000 },
    });
    expect(only(snap, '5h').usedUnits).toBe(2500);
  });

  it('counts only Fable requests toward the Fable window', () => {
    const snap = buildUsageLimits(
      [
        sidecar({ at: agoMin(10), model: 'claude-fable-5', tokens }),
        sidecar({ at: agoMin(10), model: 'claude-sonnet-5', tokens }),
      ],
      { now: NOW, limits: { week: 10_000, weekFable: 10_000 } },
    );
    expect(only(snap, 'week').usedUnits).toBe(5000);
    expect(only(snap, 'weekFable').usedUnits).toBe(2500);
  });

  it('marks a window the retained logs cannot fully cover', () => {
    // Only 30m of a 5h window is backed by logs, so the count is a floor.
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], { now: NOW, limits: { '5h': 10_000 } });
    const w = only(snap, '5h');
    expect(w.coverage).toBeCloseTo(0.1);
    expect(w.pace.blurb).toMatch(/still on disk, so the real figure is higher/);
  });

  it('reports full coverage once the logs span the whole window', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(5 * 60), tokens }), sidecar({ at: agoMin(1), tokens })], {
      now: NOW,
      limits: { '5h': 10_000 },
    });
    const w = only(snap, '5h');
    expect(w.coverage).toBe(1);
    expect(w.pace.blurb).not.toMatch(/still on disk/);
  });

  // NOW is 14:00 EDT on 2026-07-30, so the 5h window sits inside that one day and
  // the weekly window opens mid-afternoon on 2026-07-23.
  const WEEK_DAYS = ['23', '24', '25', '26', '27', '28', '29', '30'].map((d) => `2026-07-${d}`);

  it('counts the days retained rather than the span back to the oldest log', () => {
    // One request 30m ago, but the whole day's logs are held: nothing rotated out,
    // so the quiet stretch before it is genuinely quiet.
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], {
      now: NOW,
      limits: { '5h': 10_000 },
      retainedDays: ['2026-07-30'],
    });
    const w = only(snap, '5h');
    expect(w.coverage).toBe(1);
    expect(w.pace.blurb).not.toMatch(/still on disk/);
  });

  it('reports a hole in the middle of the window instead of hiding it', () => {
    const logs = [sidecar({ at: agoMin(7 * 24 * 60 - 60), tokens }), sidecar({ at: agoMin(30), tokens })];
    const retainedDays = WEEK_DAYS.filter((d) => d !== '2026-07-26' && d !== '2026-07-27');

    // Measuring back to the oldest survivor spans the window, clearing the 0.95
    // threshold and dropping the `partial` marking along with it.
    const spanned = only(buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 } }), 'week');
    expect(spanned.coverage).toBeGreaterThan(0.95);
    expect(spanned.pace.blurb).not.toMatch(/still on disk/);

    const w = only(buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 }, retainedDays }), 'week');
    expect(w.coverage).toBeCloseTo(5 / 7, 2); // two of seven days missing
    expect(w.pace.blurb).toMatch(/still on disk, so the real figure is higher/);
  });

  it('reads a fully retained week as complete coverage', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], {
      now: NOW,
      limits: { week: 10_000 },
      retainedDays: WEEK_DAYS,
    });
    expect(only(snap, 'week').coverage).toBe(1);
  });

  it('ignores retained days outside the window and unparseable labels', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], {
      now: NOW,
      limits: { '5h': 10_000 },
      retainedDays: ['2026-07-30', '2026-07-30', '2026-01-01', 'not-a-day'],
    });
    expect(only(snap, '5h').coverage).toBe(1);
  });

  it('reports going over the ceiling as exhausted, without claiming requests are refused', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens })], { now: NOW, limits: { '5h': 2000 } });
    const w = only(snap, '5h');
    expect(w.utilization).toBeGreaterThan(1);
    expect(w.pace.status).toBe('exhausted');
    // The ceiling here is the operator's own estimate, not Anthropic's ruling.
    expect(w.pace.blurb).toMatch(/over the configured/i);
    expect(w.pace.blurb).not.toMatch(/refused/i);
    expect(w.pace.blurb).not.toMatch(/no reset time/i);
  });

  it('keeps the coverage caveat when an estimate is over budget', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], { now: NOW, limits: { '5h': 500 } });
    const w = only(snap, '5h');
    expect(w.pace.status).toBe('exhausted');
    expect(w.pace.blurb).toMatch(/still on disk/);
  });

  it('prefers captured headers over an estimate for the same window', () => {
    const snap = buildUsageLimits(
      [sidecar({ at: agoMin(10), tokens, rateLimit: { 'anthropic-ratelimit-unified-5h-utilization': '0.9' } })],
      { now: NOW, limits: { '5h': 10_000 } },
    );
    const w = only(snap, '5h');
    expect(w.source).toBe('headers');
    expect(w.utilization).toBeCloseTo(0.9);
  });
});

describe('buildUsageLimits — nothing to measure', () => {
  it('omits a window with neither headers nor a configured ceiling', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10) })], { now: NOW });
    expect(snap.windows).toEqual([]);
    expect(snap.unavailable).toMatch(/USAGE_LIMIT_5H/);
  });

  it('says so plainly when there are no recent requests at all', () => {
    // A 0%-used meter would read as "well within limits", so none is emitted.
    const snap = buildUsageLimits([], { now: NOW, limits: { '5h': 1000 } });
    expect(snap.windows).toEqual([]);
    expect(snap.unavailable).toMatch(/no requests captured/i);
  });

  it('skips malformed entries instead of failing the snapshot', () => {
    const snap = buildUsageLimits([{ nope: true }, 'junk', null, sidecar({ at: agoMin(10) })], {
      now: NOW,
      limits: { '5h': 10_000 },
    });
    expect(snap.meta.requests).toBe(1);
  });

  it('ignores a request stamped in the future', () => {
    const snap = buildUsageLimits([sidecar({ at: inMin(120) })], { now: NOW, limits: { '5h': 10_000 } });
    expect(snap.meta.requests).toBe(0);
  });
});

/** Hours before NOW, as an ISO stamp. */
const agoHr = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/**
 * A token-free request far enough back to establish how long the logs reach.
 * The window holding the oldest request is never fully spanned, so without an
 * anchor a fixture's peak lands in exactly the window that gets excluded.
 */
const anchor = (h: number) => sidecar({ at: agoHr(h) });

describe('learnCeilings', () => {
  it('takes the peak of the completed windows and ignores the one in progress', () => {
    // 25h is five 5h windows, four of them complete, peaking at 900. The
    // in-progress one is the largest, so counting it would be visibly wrong.
    const learned = learnCeilings(
      [
        sidecar({ at: agoHr(25), tokens: { input: 100 } }),
        sidecar({ at: agoHr(12), tokens: { input: 900 } }),
        sidecar({ at: agoHr(7), tokens: { input: 300 } }),
        sidecar({ at: agoHr(1), tokens: { input: 5000 } }),
      ],
      NOW,
    );
    expect(learned['5h']?.units).toBe(900);
    expect(learned['5h']?.windows).toBe(4);
  });

  it('sums every request inside one window rather than taking the largest single request', () => {
    const learned = learnCeilings(
      [
        anchor(20),
        sidecar({ at: agoHr(13), tokens: { input: 40 } }),
        sidecar({ at: agoHr(12), tokens: { input: 60 } }),
        sidecar({ at: agoHr(7), tokens: { input: 80 } }),
      ],
      NOW,
    );
    expect(learned['5h']?.units).toBe(100);
  });

  it('weights the peak the same way the meter counts usage', () => {
    const learned = learnCeilings(
      [anchor(20), sidecar({ at: agoHr(12), tokens: { cacheRead: 1000, output: 50 } })],
      NOW,
    );
    expect(learned['5h']?.units).toBe(
      usageUnits({ input: 0, output: 50, cacheRead: 1000, cacheCreation: 0, realInput: 0 }),
    );
  });

  it('excludes the window holding the oldest request, which the logs only partly span', () => {
    // With no anchor the 900 sits in the earliest, partially-covered window.
    const learned = learnCeilings(
      [sidecar({ at: agoHr(12), tokens: { input: 900 } }), sidecar({ at: agoHr(7), tokens: { input: 80 } })],
      NOW,
    );
    expect(learned['5h']?.units).toBe(80);
  });

  it('says nothing when the history has not completed a single window', () => {
    // Under 10h of logs cannot close a 5h window and leave one in progress.
    const learned = learnCeilings([sidecar({ at: agoHr(4), tokens: { input: 500 } })], NOW);
    expect(learned['5h']).toBeUndefined();
    expect(learned.week).toBeUndefined();
  });

  it('learns a weekly ceiling only once the archive spans more than one week', () => {
    const thin = learnCeilings([sidecar({ at: agoHr(24 * 6), tokens: { input: 500 } })], NOW);
    expect(thin.week).toBeUndefined();

    const wide = learnCeilings(
      [
        anchor(24 * 25),
        sidecar({ at: agoHr(24 * 20), tokens: { input: 700 } }),
        sidecar({ at: agoHr(24 * 9), tokens: { input: 400 } }),
      ],
      NOW,
    );
    expect(wide.week?.units).toBe(700);
  });

  it('counts only Fable traffic toward the Fable window, and learns nothing without any', () => {
    const sonnetOnly = learnCeilings(
      [anchor(24 * 25), sidecar({ at: agoHr(24 * 20), model: 'claude-sonnet-5', tokens: { input: 900 } })],
      NOW,
    );
    expect(sonnetOnly.week?.units).toBe(900);
    expect(sonnetOnly.weekFable).toBeUndefined();

    const withFable = learnCeilings(
      [
        anchor(24 * 25),
        sidecar({ at: agoHr(24 * 20), model: 'claude-sonnet-5', tokens: { input: 900 } }),
        sidecar({ at: agoHr(24 * 19), model: 'claude-fable-5', tokens: { input: 250 } }),
      ],
      NOW,
    );
    expect(withFable.weekFable?.units).toBe(250);
  });

  it('skips malformed and clock-skewed entries', () => {
    const learned = learnCeilings(
      [
        'junk',
        null,
        { nope: true },
        anchor(20),
        sidecar({ at: inMin(600), tokens: { input: 9999 } }),
        sidecar({ at: agoHr(12), tokens: { input: 120 } }),
      ],
      NOW,
    );
    expect(learned['5h']?.units).toBe(120);
  });
});

describe('buildUsageLimits — against a learned ceiling', () => {
  /** Enough history to close several 5h windows, peaking at 1000 units. */
  const history = [
    sidecar({ at: agoHr(25), tokens: { input: 200 } }),
    sidecar({ at: agoHr(12), tokens: { input: 1000 } }),
    sidecar({ at: agoHr(7), tokens: { input: 400 } }),
  ];

  it('measures against the busiest completed window when nothing is configured', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens: { input: 250 } })], {
      now: NOW,
      history: [...history, sidecar({ at: agoMin(10), tokens: { input: 250 } })],
    });
    const w = only(snap, '5h');
    expect(w.source).toBe('learned');
    expect(w.limitUnits).toBe(1000);
    expect(w.usedUnits).toBe(250);
    expect(w.utilization).toBeCloseTo(0.25);
    expect(w.learned?.windows).toBe(4);
  });

  it('never claims the account is within a limit it was never told', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens: { input: 250 } })], {
      now: NOW,
      history: [...history, sidecar({ at: agoMin(10), tokens: { input: 250 } })],
    });
    const w = only(snap, '5h');
    expect(w.pace.blurb).not.toMatch(/within limits|sustainable/i);
    expect(w.pace.blurb).toMatch(/floor on the real allowance/i);
    expect(w.pace.blurb).toMatch(/USAGE_LIMIT_5H/);
  });

  it('calls passing the record new territory rather than a refusal', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens: { input: 4000 } })], {
      now: NOW,
      history: [...history, sidecar({ at: agoMin(10), tokens: { input: 4000 } })],
    });
    const w = only(snap, '5h');
    expect(w.pace.status).toBe('exhausted');
    expect(w.pace.blurb).toMatch(/new territory/i);
    expect(w.pace.blurb).not.toMatch(/refus/i);
  });

  it('lets a configured ceiling override what history would have inferred', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens: { input: 250 } })], {
      now: NOW,
      limits: { '5h': 5000 },
      history: [...history, sidecar({ at: agoMin(10), tokens: { input: 250 } })],
    });
    const w = only(snap, '5h');
    expect(w.source).toBe('estimated');
    expect(w.limitUnits).toBe(5000);
    expect(w.learned).toBeNull();
  });

  it('still prefers captured headers over a learned ceiling', () => {
    const head = sidecar({
      at: agoMin(5),
      tokens: { input: 250 },
      rateLimit: { 'anthropic-ratelimit-unified-5h-limit': '100', 'anthropic-ratelimit-unified-5h-remaining': '10' },
    });
    const snap = buildUsageLimits([head], { now: NOW, history: [...history, head] });
    const w = only(snap, '5h');
    expect(w.source).toBe('headers');
    expect(w.learned).toBeNull();
  });

  it('accepts ceilings the caller learned earlier instead of re-reading history', () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens: { input: 300 } })], {
      now: NOW,
      learned: { '5h': { units: 1200, windows: 9, observedMs: 48 * 3_600_000 } },
    });
    const w = only(snap, '5h');
    expect(w.source).toBe('learned');
    expect(w.limitUnits).toBe(1200);
    expect(w.utilization).toBeCloseTo(0.25);
    expect(w.pace.blurb).toMatch(/9 completed/);
  });

  it('falls back to the visible sidecars when no wider history is supplied', () => {
    const snap = buildUsageLimits(history, { now: NOW });
    expect(only(snap, '5h').source).toBe('learned');
  });
});
