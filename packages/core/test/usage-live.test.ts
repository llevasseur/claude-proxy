import { describe, expect, it } from 'vitest';
import { buildUsageLimits, parseLiveUsage } from '../src/usage-limits.js';

const NOW = new Date('2026-07-30T18:00:00.000Z');

const agoMin = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();
const inMin = (m: number): string => new Date(NOW.getTime() + m * 60_000).toISOString();

function sidecar(at: string, input: number, model = 'claude-sonnet-5') {
  return {
    timestamp: at,
    model,
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 },
    request: { toolCount: 0, toolsBytes: 0, systemBytes: 0, totalBytes: 0 },
    tools: [],
  };
}

const only = (s: ReturnType<typeof buildUsageLimits>, kind: string) => {
  const w = s.windows.find((x) => x.kind === kind);
  if (!w) throw new Error(`no ${kind} window in [${s.windows.map((x) => x.kind).join(', ')}]`);
  return w;
};

describe('parseLiveUsage', () => {
  it("maps the endpoint's window kinds onto the meters", () => {
    const got = parseLiveUsage(
      [
        { kind: 'five_hour', percent: 10, resets_at: inMin(60) },
        { kind: 'seven_day', percent: 7, resets_at: inMin(60 * 24 * 7) },
      ],
      NOW,
    );
    expect(got['5h']?.utilization).toBeCloseTo(0.1, 5);
    expect(got.week?.utilization).toBeCloseTo(0.07, 5);
    expect(got['5h']?.resetsAt).toBe(inMin(60));
  });

  it('maps a real captured payload, whose kinds are spelled differently', () => {
    // Verbatim shape of a live /api/oauth/usage response.
    const got = parseLiveUsage(
      [
        { kind: 'session', percent: 24, resets_at: '2026-08-02T00:50:00.191996+00:00' },
        { kind: 'weekly_all', percent: 8, resets_at: '2026-08-08T12:00:00.192018+00:00' },
        { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
      ],
      NOW,
    );
    expect(got['5h']?.utilization).toBeCloseTo(0.24, 5);
    expect(got.week?.utilization).toBeCloseTo(0.08, 5);
    expect(got.weekFable?.utilization).toBe(0);
    expect(got.week?.resetsAt).toBe('2026-08-08T12:00:00.192Z');
  });

  it("reads the Fable window off the scoped entry's model name", () => {
    const got = parseLiveUsage(
      [{ kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } }, resets_at: inMin(10) }],
      NOW,
    );
    expect(got.weekFable?.utilization).toBe(0);
  });

  it('skips a scoped window for some other model rather than mislabelling it', () => {
    const got = parseLiveUsage(
      [{ kind: 'weekly_scoped', percent: 42, scope: { model: { display_name: 'Sonnet' } } }],
      NOW,
    );
    expect(got).toEqual({});
  });

  it('skips kinds it does not recognise', () => {
    expect(parseLiveUsage([{ kind: 'some_new_window', percent: 99 }], NOW)).toEqual({});
  });

  it('accepts epoch-second resets and a limits-wrapped payload', () => {
    const at = Math.floor(new Date(inMin(30)).getTime() / 1000);
    const got = parseLiveUsage({ limits: [{ kind: 'five_hour', percent: 50, resets_at: at }] }, NOW);
    expect(got['5h']?.resetsAt).toBe(inMin(30));
  });

  it('drops an entry with no usable percent', () => {
    expect(parseLiveUsage([{ kind: 'five_hour', resets_at: inMin(5) }], NOW)).toEqual({});
    expect(parseLiveUsage('not a payload', NOW)).toEqual({});
  });
});

describe('buildUsageLimits — live source', () => {
  const logs = [sidecar(agoMin(30), 1_000_000)];

  it("reports Anthropic's own figure rather than the estimate", () => {
    const s = buildUsageLimits(logs, {
      now: NOW,
      limits: { week: 10_000 },
      live: { week: { utilization: 0.07, resetsAt: inMin(60 * 24 * 7) } },
    });
    const w = only(s, 'week');
    expect(w.source).toBe('live');
    expect(w.utilization).toBeCloseTo(0.07, 5);
    expect(w.coverage).toBe(1);
    // The estimate would have read 100x this against the configured ceiling.
    expect(w.usedUnits).toBeNull();
  });

  it('falls back per window, so one live reading does not hide the others', () => {
    const s = buildUsageLimits(logs, {
      now: NOW,
      limits: { '5h': 10_000_000, week: 10_000_000 },
      live: { week: { utilization: 0.07, resetsAt: null } },
    });
    expect(only(s, 'week').source).toBe('live');
    expect(only(s, '5h').source).toBe('estimated');
  });
});

describe('buildUsageLimits — fixed-window anchors', () => {
  // A week's worth of traffic, but the allowance reset 7h ago: only the last
  // request belongs to the window now in progress.
  const logs = [sidecar(agoMin(60 * 24 * 5), 800), sidecar(agoMin(60 * 24 * 2), 800), sidecar(agoMin(30), 100)];
  const resetsAt = inMin(60 * 24 * 7 - 60 * 7);

  it('counts from where the window opened, not a trailing seven days', () => {
    const anchored = only(
      buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 }, anchors: { week: resetsAt } }),
      'week',
    );
    const trailing = only(buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 } }), 'week');
    expect(anchored.usedUnits).toBe(100);
    expect(trailing.usedUnits).toBe(1700);
    expect(anchored.resetsAt).toBe(resetsAt);
  });

  it('does not call a freshly-reset window partial when its logs are all present', () => {
    const w = only(
      buildUsageLimits(logs, {
        now: NOW,
        limits: { week: 10_000 },
        anchors: { week: resetsAt },
        retainedDays: ['2026-07-29', '2026-07-30'],
      }),
      'week',
    );
    // 7h elapsed, all of it retained — measuring against the nominal 168h would
    // read 4% and stamp `partial` on a complete count.
    expect(w.coverage).toBe(1);
    expect(w.pace.blurb).not.toMatch(/still on disk/);
  });

  it('ignores an unparseable or future-dated anchor', () => {
    const bad = only(
      buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 }, anchors: { week: 'nonsense' } }),
      'week',
    );
    expect(bad.usedUnits).toBe(1700);
    expect(bad.resetsAt).toBeNull();

    // More than a window out, so the span it describes has not opened yet.
    const future = only(
      buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 }, anchors: { week: inMin(60 * 24 * 9) } }),
      'week',
    );
    expect(future.usedUnits).toBe(1700);
    expect(future.resetsAt).toBeNull();
  });

  it('words an anchored window from its reset, not as a trailing span', () => {
    const anchored = only(
      buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 }, anchors: { week: resetsAt } }),
      'week',
    );
    expect(anchored.pace.blurb).not.toMatch(/trailing/);
    expect(anchored.pace.blurb).toMatch(/since it reset/);
    expect(anchored.pace.blurb).toMatch(/resets in/);

    const trailing = only(buildUsageLimits(logs, { now: NOW, limits: { week: 10_000 } }), 'week');
    expect(trailing.pace.blurb).toMatch(/trailing/);
    expect(trailing.pace.blurb).not.toMatch(/resets in/);
  });
});
