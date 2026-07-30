import { describe, expect, it } from "vitest";
import { buildUsageLimits, fmtDuration, usageUnits, windowOfHeader } from "../src/usage-limits.js";

const NOW = new Date("2026-07-30T18:00:00.000Z");

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
    model: over.model ?? "claude-sonnet-5",
    endpoint: "POST /v1/messages",
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
  if (!w) throw new Error(`no ${kind} window in [${s.windows.map((x) => x.kind).join(", ")}]`);
  return w;
};

describe("windowOfHeader", () => {
  it("classifies the unified window headers", () => {
    expect(windowOfHeader("anthropic-ratelimit-unified-5h-remaining")).toBe("5h");
    expect(windowOfHeader("anthropic-ratelimit-unified-7d-remaining")).toBe("week");
    expect(windowOfHeader("anthropic-ratelimit-unified-week-limit")).toBe("week");
  });

  it("routes the top-tier weekly window to its own meter", () => {
    // Anthropic has named this window after Opus; Fable is the current top tier.
    expect(windowOfHeader("anthropic-ratelimit-unified-7d-opus-remaining")).toBe("weekFable");
    expect(windowOfHeader("anthropic-ratelimit-unified-7d-fable-remaining")).toBe("weekFable");
  });

  it("ignores headers that name no window", () => {
    expect(windowOfHeader("anthropic-ratelimit-requests-remaining")).toBeNull();
    expect(windowOfHeader("content-type")).toBeNull();
  });
});

describe("usageUnits", () => {
  it("discounts cache reads tenfold and ignores realInput", () => {
    // realInput double-counts input + cacheRead + cacheCreation, so it must not add.
    expect(usageUnits({ input: 1000, output: 500, cacheRead: 10_000, cacheCreation: 0, realInput: 11_000 })).toBe(2500);
  });
});

describe("fmtDuration", () => {
  it("renders at blurb width", () => {
    expect(fmtDuration(45 * 60_000)).toBe("45m");
    expect(fmtDuration(3 * 3600_000 + 40 * 60_000)).toBe("3h 40m");
    expect(fmtDuration(2 * 86_400_000 + 4 * 3600_000)).toBe("2d 4h");
  });
});

describe("buildUsageLimits — from captured headers", () => {
  it("derives utilization from limit and remaining, and reads the reset instant", () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "100",
            "anthropic-ratelimit-unified-5h-remaining": "90",
            "anthropic-ratelimit-unified-5h-reset": inMin(60),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, "5h");
    expect(w.source).toBe("headers");
    expect(w.utilization).toBeCloseTo(0.1);
    expect(w.resetsAt).toBe(inMin(60));
    expect(snap.meta.fromHeaders).toBe(1);
  });

  it("flags a rate that would exhaust the window before it resets", () => {
    // 80% spent with 1h of a 5h window left — 80% elapsed, so it lands at ~100%.
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "100",
            "anthropic-ratelimit-unified-5h-remaining": "20",
            "anthropic-ratelimit-unified-5h-reset": inMin(60),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, "5h");
    expect(w.pace.status).toBe("aggressive");
    expect(w.pace.projected).toBeCloseTo(1);
    expect(w.pace.blurb).toMatch(/faster than it refills/i);
  });

  it("calls a rate safe when it projects well under the ceiling", () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "100",
            "anthropic-ratelimit-unified-5h-remaining": "90",
            "anthropic-ratelimit-unified-5h-reset": inMin(60),
          },
        }),
      ],
      { now: NOW },
    );
    expect(only(snap, "5h").pace.status).toBe("safe");
  });

  it("warns when the projection lands near but under the ceiling", () => {
    // 50% spent with 2h of 5h left → 60% elapsed → projects ~83%.
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "100",
            "anthropic-ratelimit-unified-5h-remaining": "50",
            "anthropic-ratelimit-unified-5h-reset": inMin(120),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, "5h");
    expect(w.pace.status).toBe("on-pace");
    expect(w.pace.projected).toBeCloseTo(0.8333, 3);
  });

  it("reports an emptied allowance as exhausted", () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "100",
            "anthropic-ratelimit-unified-5h-remaining": "0",
            "anthropic-ratelimit-unified-5h-reset": inMin(30),
          },
        }),
      ],
      { now: NOW },
    );
    const w = only(snap, "5h");
    expect(w.pace.status).toBe("exhausted");
    // Anthropic reported this one, so the allowance really does bind.
    expect(w.pace.blurb).toMatch(/resets in 30m/);
    expect(w.pace.blurb).toMatch(/refused/i);
  });

  it("accepts a utilization header as a fraction or a percentage", () => {
    const frac = buildUsageLimits([sidecar({ rateLimit: { "anthropic-ratelimit-unified-5h-utilization": "0.42" } })], {
      now: NOW,
    });
    expect(only(frac, "5h").utilization).toBeCloseTo(0.42);

    const percent = buildUsageLimits([sidecar({ rateLimit: { "anthropic-ratelimit-unified-5h-utilization": "42" } })], {
      now: NOW,
    });
    expect(only(percent, "5h").utilization).toBeCloseTo(0.42);
  });

  it("reads a reset given as epoch seconds or as seconds-from-now", () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 3600;
    const asEpoch = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "10",
            "anthropic-ratelimit-unified-5h-remaining": "5",
            "anthropic-ratelimit-unified-5h-reset": String(epoch),
          },
        }),
      ],
      { now: NOW },
    );
    expect(only(asEpoch, "5h").resetsAt).toBe(inMin(60));

    const asDelta = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-limit": "10",
            "anthropic-ratelimit-unified-5h-remaining": "5",
            "anthropic-ratelimit-unified-5h-reset": "3600",
          },
        }),
      ],
      { now: NOW },
    );
    expect(only(asDelta, "5h").resetsAt).toBe(inMin(60));
  });

  it("takes the newest request's headers, not an older reading", () => {
    const snap = buildUsageLimits(
      [
        sidecar({ at: agoMin(90), rateLimit: { "anthropic-ratelimit-unified-5h-utilization": "0.10" } }),
        sidecar({ at: agoMin(5), rateLimit: { "anthropic-ratelimit-unified-5h-utilization": "0.70" } }),
      ],
      { now: NOW },
    );
    expect(only(snap, "5h").utilization).toBeCloseTo(0.7);
  });

  it("surfaces all three windows when the headers cover them", () => {
    const snap = buildUsageLimits(
      [
        sidecar({
          rateLimit: {
            "anthropic-ratelimit-unified-5h-utilization": "0.2",
            "anthropic-ratelimit-unified-7d-utilization": "0.4",
            "anthropic-ratelimit-unified-7d-opus-utilization": "0.6",
          },
        }),
      ],
      { now: NOW },
    );
    expect(snap.windows.map((w) => w.kind)).toEqual(["5h", "week", "weekFable"]);
  });
});

describe("buildUsageLimits — estimated from logged tokens", () => {
  const tokens = { input: 1000, output: 500, cacheRead: 10_000 }; // 2500 units each

  it("counts weighted units in the trailing window against the configured ceiling", () => {
    const snap = buildUsageLimits(
      [sidecar({ at: agoMin(30), tokens }), sidecar({ at: agoMin(10), tokens })],
      { now: NOW, limits: { "5h": 10_000 } },
    );
    const w = only(snap, "5h");
    expect(w.source).toBe("estimated");
    expect(w.usedUnits).toBe(5000);
    expect(w.limitUnits).toBe(10_000);
    expect(w.utilization).toBeCloseTo(0.5);
    expect(w.resetsAt).toBeNull();
    expect(w.pace.blurb).toMatch(/trailing/i);
  });

  it("leaves requests outside the window out of the count", () => {
    const snap = buildUsageLimits(
      [sidecar({ at: agoMin(6 * 60), tokens }), sidecar({ at: agoMin(10), tokens })],
      { now: NOW, limits: { "5h": 10_000 } },
    );
    expect(only(snap, "5h").usedUnits).toBe(2500);
  });

  it("counts only Fable requests toward the Fable window", () => {
    const snap = buildUsageLimits(
      [
        sidecar({ at: agoMin(10), model: "claude-fable-5", tokens }),
        sidecar({ at: agoMin(10), model: "claude-sonnet-5", tokens }),
      ],
      { now: NOW, limits: { week: 10_000, weekFable: 10_000 } },
    );
    expect(only(snap, "week").usedUnits).toBe(5000);
    expect(only(snap, "weekFable").usedUnits).toBe(2500);
  });

  it("marks a window the retained logs cannot fully cover", () => {
    // Only 30m of a 5h window is backed by logs, so the count is a floor.
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], { now: NOW, limits: { "5h": 10_000 } });
    const w = only(snap, "5h");
    expect(w.coverage).toBeCloseTo(0.1);
    expect(w.pace.blurb).toMatch(/still on disk, so the real figure is higher/);
  });

  it("reports full coverage once the logs span the whole window", () => {
    const snap = buildUsageLimits(
      [sidecar({ at: agoMin(5 * 60), tokens }), sidecar({ at: agoMin(1), tokens })],
      { now: NOW, limits: { "5h": 10_000 } },
    );
    const w = only(snap, "5h");
    expect(w.coverage).toBe(1);
    expect(w.pace.blurb).not.toMatch(/still on disk/);
  });

  it("reports going over the ceiling as exhausted, without claiming requests are refused", () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10), tokens })], { now: NOW, limits: { "5h": 2000 } });
    const w = only(snap, "5h");
    expect(w.utilization).toBeGreaterThan(1);
    expect(w.pace.status).toBe("exhausted");
    // The ceiling here is the operator's own estimate, not Anthropic's ruling.
    expect(w.pace.blurb).toMatch(/over the configured/i);
    expect(w.pace.blurb).not.toMatch(/refused/i);
    expect(w.pace.blurb).not.toMatch(/no reset time/i);
  });

  it("keeps the coverage caveat when an estimate is over budget", () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(30), tokens })], { now: NOW, limits: { "5h": 500 } });
    const w = only(snap, "5h");
    expect(w.pace.status).toBe("exhausted");
    expect(w.pace.blurb).toMatch(/still on disk/);
  });

  it("prefers captured headers over an estimate for the same window", () => {
    const snap = buildUsageLimits(
      [sidecar({ at: agoMin(10), tokens, rateLimit: { "anthropic-ratelimit-unified-5h-utilization": "0.9" } })],
      { now: NOW, limits: { "5h": 10_000 } },
    );
    const w = only(snap, "5h");
    expect(w.source).toBe("headers");
    expect(w.utilization).toBeCloseTo(0.9);
  });
});

describe("buildUsageLimits — nothing to measure", () => {
  it("omits a window with neither headers nor a configured ceiling", () => {
    const snap = buildUsageLimits([sidecar({ at: agoMin(10) })], { now: NOW });
    expect(snap.windows).toEqual([]);
    expect(snap.unavailable).toMatch(/USAGE_LIMIT_5H/);
  });

  it("says so plainly when there are no recent requests at all", () => {
    // A 0%-used meter would read as "well within limits" when the truth is that
    // nothing was observed, so no window is emitted even with a ceiling set.
    const snap = buildUsageLimits([], { now: NOW, limits: { "5h": 1000 } });
    expect(snap.windows).toEqual([]);
    expect(snap.unavailable).toMatch(/no requests captured/i);
  });

  it("skips malformed entries instead of failing the snapshot", () => {
    const snap = buildUsageLimits([{ nope: true }, "junk", null, sidecar({ at: agoMin(10) })], {
      now: NOW,
      limits: { "5h": 10_000 },
    });
    expect(snap.meta.requests).toBe(1);
  });

  it("ignores a request stamped in the future", () => {
    const snap = buildUsageLimits([sidecar({ at: inMin(120) })], { now: NOW, limits: { "5h": 10_000 } });
    expect(snap.meta.requests).toBe(0);
  });
});
