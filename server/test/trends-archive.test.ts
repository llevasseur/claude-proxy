import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTrends, clearRawArchiveCache } from "../src/api.js";
import { clearArchiveCache } from "../src/archive.js";

// 10:00 EDT on the 17th — the reporting day the window ends on.
const NOW = new Date("2026-07-17T14:00:00.000Z");

/** A valid audit sidecar: two tools worth 6,000 est. tokens against 9,100 real input. */
function sidecar(iso: string): string {
  const tools = [
    { name: "Workflow", bytes: 20_000, estTokens: 5_000 },
    { name: "Bash", bytes: 4_000, estTokens: 1_000 },
  ];
  return JSON.stringify({
    timestamp: iso,
    model: "claude-opus-4-8",
    endpoint: "POST /v1/messages",
    statusCode: 200,
    tokens: { input: 100, output: 500, cacheRead: 8_000, cacheCreation: 1_000, realInput: 9_100 },
    request: { toolCount: 2, toolsBytes: 24_000, systemBytes: 8_000, totalBytes: 60_000 },
    tools,
  });
}

/** 6,000 / 9,100 — what a correctly recomputed digest reports for these sidecars. */
const EXPECTED_OVERHEAD = (6_000 / 9_100) * 100;

async function writeSidecar(dir: string, iso: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = `${iso.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic.audit.json`;
  await writeFile(path.join(dir, name), sidecar(iso), "utf8");
}

/**
 * A finalized digest in the shape the external summary job actually writes: no
 * `toolOverheadPctOfInput` at all, and the older `toolBytesPctOfRequest` in its
 * place. `requestCount` is deliberately absurd so a test can tell which source
 * a day's digest came from.
 */
async function writeFinalizedDigest(archiveDir: string, date: string): Promise<void> {
  await mkdir(path.join(archiveDir, date), { recursive: true });
  await writeFile(
    path.join(archiveDir, date, "digest.json"),
    JSON.stringify({
      date,
      requestCount: 999,
      skipped: 0,
      models: { "claude-opus-4-8": 999 },
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, realInput: 5, cacheHitRatio: 0.6 },
      cost: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, total: 10 },
      topTools: [{ name: "Workflow", totalBytes: 20_000, estTokens: 5_000, pctOfToolBytes: 83.3 }],
      avgSystemPromptBytes: 8_000,
      toolBytesPctOfRequest: 40,
      busiestHour: { hour: 13, requestCount: 999 },
    }),
    "utf8",
  );
}

async function fixture(): Promise<{ logDir: string; archiveDir: string }> {
  const logDir = await mkdtemp(path.join(tmpdir(), "trends-logs-"));
  const archiveDir = await mkdtemp(path.join(tmpdir(), "trends-archive-"));
  await writeSidecar(logDir, "2026-07-17T14:00:00.000Z"); // today, still live
  return { logDir, archiveDir };
}

const dayOf = (r: Awaited<ReturnType<typeof buildTrends>>, date: string) =>
  r.digests.find((d) => d.date === date);

beforeEach(() => {
  clearRawArchiveCache();
  clearArchiveCache();
});

describe("buildTrends archive fallbacks", () => {
  it("recomputes an archived day from the digest archive's raw sidecars", async () => {
    const { logDir, archiveDir } = await fixture();
    await writeSidecar(path.join(archiveDir, "2026-07-15", "raw"), "2026-07-15T14:00:00.000Z");
    await writeSidecar(path.join(archiveDir, "2026-07-15", "raw"), "2026-07-15T18:00:00.000Z");
    await writeFinalizedDigest(archiveDir, "2026-07-15");

    const day = dayOf(await buildTrends(logDir, 5, NOW, archiveDir), "2026-07-15");
    expect(day?.requestCount).toBe(2);
    expect(day?.toolOverheadPctOfInput).toBeCloseTo(EXPECTED_OVERHEAD, 6);
  });

  it("still recomputes from the legacy `<logDir>/archive/` layout", async () => {
    const { logDir, archiveDir } = await fixture();
    await writeSidecar(path.join(logDir, "archive", "2026-07-15"), "2026-07-15T14:00:00.000Z");

    const day = dayOf(await buildTrends(logDir, 5, NOW, archiveDir), "2026-07-15");
    expect(day?.requestCount).toBe(1);
    expect(day?.toolOverheadPctOfInput).toBeCloseTo(EXPECTED_OVERHEAD, 6);
  });

  it("falls back to the finalized digest once raw has been pruned", async () => {
    const { logDir, archiveDir } = await fixture();
    await writeFinalizedDigest(archiveDir, "2026-07-14");

    const day = dayOf(await buildTrends(logDir, 5, NOW, archiveDir), "2026-07-14");
    expect(day?.requestCount).toBe(999);
    // Genuinely unrecoverable: the raw capture that carried it is gone.
    expect(day?.toolOverheadPctOfInput).toBe(0);
  });

  it("works off live logs alone when no archive exists", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "trends-solo-"));
    await writeSidecar(logDir, "2026-07-17T14:00:00.000Z");

    const res = await buildTrends(logDir, 5, NOW);
    expect(res.meta.archivedDays).toBe(0);
    expect(res.digests.map((d) => d.date)).toEqual(["2026-07-17"]);
  });

  it("does not throw when the archive directory is missing", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "trends-missing-"));
    await writeSidecar(logDir, "2026-07-17T14:00:00.000Z");

    const res = await buildTrends(logDir, 5, NOW, path.join(logDir, "no-such-archive"));
    expect(res.meta.archivedDays).toBe(0);
    expect(dayOf(res, "2026-07-17")?.requestCount).toBe(1);
  });

  it("caches archived hits but not misses, so a day can gain its archive later", async () => {
    const { logDir, archiveDir } = await fixture();

    const before = await buildTrends(logDir, 5, NOW, archiveDir);
    expect(dayOf(before, "2026-07-15")).toBeUndefined();

    await writeSidecar(path.join(archiveDir, "2026-07-15", "raw"), "2026-07-15T14:00:00.000Z");

    const after = await buildTrends(logDir, 5, NOW, archiveDir);
    expect(dayOf(after, "2026-07-15")?.requestCount).toBe(1);
  });
});
