import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outlineWirePrompt } from "@claude-proxy/core";
import { buildPromptMix } from "../src/api.js";
import { hashWirePrompt, writeStoredPrompt } from "../src/prompt-store.js";

/** Late enough in the reporting day that `today()` is unambiguous. */
const NOW = new Date("2026-08-03T20:00:00.000Z");

async function tmpLogDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "prompt-mix-api-"));
}

/** `n` sidecars for one day, all sending the same system prompt. */
async function archive(logDir: string, day: string, n: number, model: string, system: unknown, seq = 0): Promise<string> {
  const dir = path.join(logDir, "archive", day);
  await mkdir(dir, { recursive: true });
  const outline = outlineWirePrompt(system);
  const hash = hashWirePrompt(system);
  for (let i = 0; i < n; i += 1) {
    const stamp = `${day}T${String(10 + seq).padStart(2, "0")}-${String(i).padStart(2, "0")}-00-000`;
    const sidecar = {
      timestamp: `${day}T${String(14 + seq).padStart(2, "0")}:${String(i).padStart(2, "0")}:00.000Z`,
      model,
      endpoint: "POST /v1/messages",
      statusCode: 200,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, realInput: 8 },
      request: {
        toolCount: 0,
        toolsBytes: 0,
        systemBytes: outline.bytes,
        totalBytes: outline.bytes,
        system: { hash, blocks: outline.blocks.length, sections: outline.sections.length },
      },
      tools: [],
    };
    await writeFile(path.join(dir, `${stamp}_anthropic.audit.json`), JSON.stringify(sidecar), "utf8");
  }
  return hash;
}

const big = (heading: string, filler: number) => [{ type: "text", text: `# Preface\nshort\n# ${heading}\n${"x".repeat(filler)}` }];

describe("buildPromptMix", () => {
  it("reports a day's cohorts and the mean they sum to", async () => {
    const logDir = await tmpLogDir();
    await archive(logDir, "2026-08-02", 8, "claude-opus-5", big("Small", 100));
    await archive(logDir, "2026-08-02", 2, "security-monitor", big("Huge", 40_000), 1);

    const { days } = await buildPromptMix(logDir, 7, NOW);
    const day = days.at(-1)!;
    expect(day.date).toBe("2026-08-02");
    expect(day.requests).toBe(10);
    expect(day.cohorts).toHaveLength(2);
    // The two-request cohort is 40 KB apiece, so it dominates the mean.
    expect(day.cohorts[0]!.models).toEqual(["security-monitor"]);
    expect(day.cohorts.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(day.meanBytes, 6);
    expect(day.identifiedShare).toBe(1);
  });

  it("splits a day-over-day move into mix and size, and they sum to the whole delta", async () => {
    const logDir = await tmpLogDir();
    // Same two prompts both days; only the traffic split changes.
    await archive(logDir, "2026-08-01", 9, "claude-opus-5", big("Small", 100));
    await archive(logDir, "2026-08-01", 1, "security-monitor", big("Huge", 40_000), 1);
    await archive(logDir, "2026-08-02", 5, "claude-opus-5", big("Small", 100));
    await archive(logDir, "2026-08-02", 5, "security-monitor", big("Huge", 40_000), 1);

    const { attribution } = await buildPromptMix(logDir, 7, NOW);
    expect(attribution).not.toBeNull();
    expect(attribution!.priorDate).toBe("2026-08-01");
    expect(attribution!.date).toBe("2026-08-02");
    expect(attribution!.deltaBytes).toBeGreaterThan(0);
    // Nothing was rewritten, so the entire move is traffic mix.
    expect(attribution!.sizeBytes).toBeCloseTo(0, 6);
    expect(attribution!.mixBytes).toBeCloseTo(attribution!.deltaBytes, 6);
  });

  it("diffs the sections of a prompt that was replaced", async () => {
    const logDir = await tmpLogDir();
    const before = big("Rules", 500);
    const after = big("Rules", 5_000);
    const priorHash = await archive(logDir, "2026-08-01", 4, "claude-opus-5", before);
    const hash = await archive(logDir, "2026-08-02", 4, "claude-opus-5", after);
    await writeStoredPrompt(logDir, priorHash, outlineWirePrompt(before), "2026-08-01T14:00:00.000Z");
    await writeStoredPrompt(logDir, hash, outlineWirePrompt(after), "2026-08-02T14:00:00.000Z");

    const { revisions, meta } = await buildPromptMix(logDir, 7, NOW);
    expect(meta.outlinesFound).toBe(2);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.moves[0]).toMatchObject({ heading: "Rules", status: "grew", deltaBytes: 4_500 });
    expect(revisions[0]!.moves.find((m) => m.heading === "Preface")!.deltaBytes).toBe(0);
  });

  it("reports a revision with no stored outline rather than dropping it", async () => {
    const logDir = await tmpLogDir();
    await archive(logDir, "2026-08-01", 4, "claude-opus-5", big("Rules", 500));
    await archive(logDir, "2026-08-02", 4, "claude-opus-5", big("Rules", 5_000));

    const { revisions, meta } = await buildPromptMix(logDir, 7, NOW);
    expect(meta.outlinesFound).toBe(0);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.prior).toBeNull();
    expect(revisions[0]!.moves).toEqual([]);
  });

  it("marks the newest day partial only while it is the reporting day", async () => {
    const logDir = await tmpLogDir();
    await archive(logDir, "2026-08-02", 2, "claude-opus-5", big("Small", 100));
    expect((await buildPromptMix(logDir, 7, NOW)).partial).toBeNull();

    await archive(logDir, "2026-08-03", 2, "claude-opus-5", big("Small", 100));
    const partial = (await buildPromptMix(logDir, 7, NOW)).partial;
    expect(partial?.date).toBe("2026-08-03");
    expect(partial!.elapsed).toBeGreaterThan(0);
    expect(partial!.elapsed).toBeLessThan(1);
  });

  it("returns an empty window rather than throwing when nothing is captured", async () => {
    const mix = await buildPromptMix(await tmpLogDir(), 7, NOW);
    expect(mix.days).toEqual([]);
    expect(mix.attribution).toBeNull();
    expect(mix.partial).toBeNull();
  });
});
