import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildUsage } from "../src/api.js";
import { clearArchivedUsageCache, clearLearnedCeilingsCache } from "../src/usage-history.js";
import { loadLiveUsage } from "../src/usage-live.js";

const NOW = new Date("2026-07-30T18:00:00.000Z");
const minsFromNow = (m: number): string => new Date(NOW.getTime() + m * 60_000).toISOString();

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), "usage-live-"));
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
});

async function write(doc: unknown): Promise<void> {
  await writeFile(path.join(logDir, "usage-live.json"), JSON.stringify(doc), "utf8");
}

describe("loadLiveUsage", () => {
  it("returns the percentages while the reading is fresh", async () => {
    await write({
      fetchedAt: minsFromNow(-1),
      payload: [{ kind: "seven_day", percent: 7, resets_at: minsFromNow(60 * 24 * 7) }],
    });

    const got = await loadLiveUsage(logDir, NOW);
    expect(got.live.week?.utilization).toBeCloseTo(0.07, 5);
    expect(got.anchors.week).toBe(minsFromNow(60 * 24 * 7));
  });

  it("drops stale percentages but keeps the anchor", async () => {
    await write({
      fetchedAt: minsFromNow(-30),
      payload: [{ kind: "seven_day", percent: 7, resets_at: minsFromNow(60 * 24 * 3) }],
    });

    const got = await loadLiveUsage(logDir, NOW);
    // Six-hour-old percentages would be wrong; the reset instant is still true.
    expect(got.live).toEqual({});
    expect(got.anchors.week).toBe(minsFromNow(60 * 24 * 3));
  });

  it("rolls a reset instant that has already passed forward a whole window", async () => {
    // Polled last week and never since: the same weekday/time, one week on.
    await write({
      fetchedAt: minsFromNow(-60 * 24 * 9),
      payload: [{ kind: "seven_day", percent: 7, resets_at: minsFromNow(-60 * 24 * 2) }],
    });

    const got = await loadLiveUsage(logDir, NOW);
    expect(got.anchors.week).toBe(minsFromNow(60 * 24 * 5));
  });

  it("reads as absent when the proxy has never polled", async () => {
    expect(await loadLiveUsage(logDir, NOW)).toEqual({ live: {}, anchors: {}, fetchedAt: null });
  });

  it("survives a truncated or malformed file", async () => {
    await writeFile(path.join(logDir, "usage-live.json"), "{not json", "utf8");
    expect((await loadLiveUsage(logDir, NOW)).live).toEqual({});
  });
});

describe("buildUsage — live source wired through", () => {
  it("shows Anthropic's figure instead of the estimate", async () => {
    const stamp = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    await writeFile(
      path.join(logDir, `${stamp.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic.audit.json`),
      JSON.stringify({
        timestamp: stamp,
        model: "claude-sonnet-5",
        endpoint: "POST /v1/messages",
        statusCode: 200,
        tokens: { input: 5_000_000, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 },
        request: { toolCount: 0, toolsBytes: 0, systemBytes: 0, totalBytes: 0 },
        tools: [],
      }),
      "utf8",
    );
    await write({
      fetchedAt: minsFromNow(-1),
      payload: [{ kind: "seven_day", percent: 7, resets_at: minsFromNow(60 * 24 * 7) }],
    });

    const { usage } = await buildUsage(logDir, { week: 10_000 }, NOW);
    const w = usage.windows.find((x) => x.kind === "week");
    // The configured ceiling would have put this at 500x; Anthropic says 7%.
    expect(w?.source).toBe("live");
    expect(w?.utilization).toBeCloseTo(0.07, 5);
  });
});
