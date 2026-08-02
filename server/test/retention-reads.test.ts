import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildContextDetail,
  buildContextMessage,
  buildContextTool,
  buildSkim,
  buildSummary,
  buildTools,
  buildTrends,
  buildUsage,
} from "../src/api.js";
import { applyRetention, planRetention, collectRetentionCorpus } from "../src/retention.js";
import { clearArchivedUsageCache, clearLearnedCeilingsCache } from "../src/usage-history.js";

/**
 * The claim this slice rests on: evicting a day's bodies costs nothing a metrics
 * route can see. Everything here runs against a temp corpus — the eviction under
 * test is the real {@link applyRetention}, pointed at a fixture, never at `logs/`.
 */

/** 14:00 EDT. The fixture day below is 40 days back, well past the 30-day window. */
const NOW = new Date("2026-08-02T18:00:00.000Z");
const OLD_DAY = "2026-06-23";
const ISO = `${OLD_DAY}T15:30:00.000Z`;
const STEM = `${ISO.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic`;

const TOOLS = [
  { name: "Bash", bytes: 400, estTokens: 100 },
  { name: "Read", bytes: 300, estTokens: 75 },
];

function sidecar(iso: string) {
  return JSON.stringify({
    timestamp: iso,
    model: "claude-sonnet-5",
    endpoint: "POST /v1/messages",
    statusCode: 200,
    tokens: { input: 1000, output: 200, cacheRead: 50, cacheCreation: 25, realInput: 925 },
    request: { toolCount: TOOLS.length, toolsBytes: 700, systemBytes: 1200, totalBytes: 4000 },
    tools: TOOLS,
    skim: { enabled: true, servedFromCache: false, savedInputTokens: 0, cacheKey: null },
  });
}

const BODY = JSON.stringify({
  system: "You are helpful.",
  tools: TOOLS.map((t) => ({ name: t.name, description: `${t.name} tool`, input_schema: { type: "object" } })),
  messages: [{ role: "user", content: [{ type: "text", text: "ask something" }] }],
});

let logDir: string;

/** One archived day, written as the proxy writes it: sidecar plus both bodies. */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), "retention-reads-"));
  const dir = path.join(logDir, "archive", OLD_DAY);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${STEM}.audit.json`), sidecar(ISO), "utf8");
  await writeFile(path.join(dir, `${STEM}.md`), `# ${ISO}\n`, "utf8");
  await writeFile(path.join(dir, `${STEM}.request.txt`), BODY, "utf8");
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
});

/** Run the real planner and the real applier over the fixture. */
async function evict(): Promise<{ evicted: number; bytesReclaimed: number; errors: string[] }> {
  const corpus = await collectRetentionCorpus(logDir);
  const plan = planRetention({ corpus, today: "2026-08-02", retentionDays: 30 });
  const result = await applyRetention(logDir, plan);
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
  return result;
}

/** The four metrics routes that read the day, serialized exactly as they are served. */
async function metrics(): Promise<string> {
  const [usage, tools, trends, summary] = await Promise.all([
    buildUsage(logDir, { week: 10_000 }, NOW),
    buildTools(logDir, OLD_DAY, NOW),
    buildTrends(logDir, 60, NOW),
    buildSummary(logDir, OLD_DAY, NOW),
  ]);
  return JSON.stringify({ usage, tools, trends, summary });
}

describe("an evicted day still serves its metrics", () => {
  it("returns byte-identical usage/tools/trends/summary before and after eviction", async () => {
    const before = await metrics();

    const result = await evict();
    expect(result.errors).toEqual([]);
    expect(result.evicted).toBe(2);
    expect(result.bytesReclaimed).toBeGreaterThan(0);

    expect(await metrics()).toBe(before);
  });

  it("keeps the sidecar and removes only the bodies", async () => {
    await evict();
    expect((await readdir(path.join(logDir, "archive", OLD_DAY))).sort()).toEqual([`${STEM}.audit.json`]);
  });

});

describe("skim counts a missing body rather than dropping the request", () => {
  const TODAY = "2026-08-02";
  const liveIso = `${TODAY}T15:30:00.000Z`;
  const liveStem = `${liveIso.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic`;

  /** Skim reads the live directory, so the fixture is written there. */
  async function writeLive(withBody: boolean): Promise<void> {
    await writeFile(path.join(logDir, `${liveStem}.audit.json`), sidecar(liveIso), "utf8");
    if (withBody) await writeFile(path.join(logDir, `${liveStem}.request.txt`), BODY, "utf8");
  }

  it("reports no evictions while the body is there", async () => {
    await writeLive(true);
    const skim = await buildSkim(logDir, TODAY, NOW);
    expect(skim.meta.files).toBe(1);
    expect(skim.meta.bodiesEvicted).toBe(0);
  });

  it("still counts the request, and says the body is gone", async () => {
    await writeLive(false);
    const skim = await buildSkim(logDir, TODAY, NOW);
    // An evicted body is a request whose text is gone, not a request that never
    // happened — the difference is exactly what this meta field exists to say.
    expect(skim.meta.files).toBe(1);
    expect(skim.meta.bodiesEvicted).toBe(1);
  });
});

describe("the context routes report eviction as a state, not a failure", () => {
  // The routes address a request by its stem; the `.request.txt` suffix is theirs to add.
  const file = STEM;

  it("serves the body while it is on disk", async () => {
    const detail = await buildContextDetail(logDir, file);
    expect(detail.evicted).toBe(false);
  });

  it("returns the evicted marker with the retained metrics", async () => {
    await evict();

    const detail = await buildContextDetail(logDir, file);
    expect(detail.evicted).toBe(true);
    if (!detail.evicted) throw new Error("unreachable");
    expect(detail.day).toBe(OLD_DAY);
    expect(detail.retentionDays).toBe(30);
    // The point of keeping the sidecar: the drill-down still has numbers to show.
    expect(detail.retained?.request.totalBytes).toBe(4000);
    expect(detail.retained?.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  it("returns it from the message and tool routes too", async () => {
    await evict();

    const message = await buildContextMessage(logDir, file, 0);
    const tool = await buildContextTool(logDir, file, 0);
    expect(message.evicted).toBe(true);
    expect(tool.evicted).toBe(true);
    expect(message.evicted && message.retained?.model).toBe("claude-sonnet-5");
  });

  it("still 404s a file that was never captured, so a bug stays visible", async () => {
    await evict();
    await expect(buildContextDetail(logDir, "2026-06-23T09-00-00-000_anthropic")).rejects.toThrow(/not found/);
  });
});
