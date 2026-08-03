import { describe, expect, it } from "vitest";
import { attributePromptMix, pairPromptRevisions, promptMixByDay, summarizePromptMix } from "../src/prompt-mix.js";
import type { AuditSidecar } from "../src/types.js";
import { makeSidecar } from "./helpers.js";

/** `n` sidecars of one model at one system-prompt size, optionally hashed. */
function cohort(n: number, model: string, systemBytes: number, hash?: string, timestamp?: string): AuditSidecar[] {
  return Array.from({ length: n }, () =>
    makeSidecar({
      model,
      ...(timestamp ? { timestamp } : {}),
      request: {
        toolCount: 0,
        toolsBytes: 0,
        systemBytes,
        totalBytes: systemBytes,
        ...(hash ? { system: { hash, blocks: 1, sections: 3 } } : {}),
      },
    }),
  );
}

describe("summarizePromptMix", () => {
  it("matches the digest's mean and reports a median that ignores the tail", () => {
    const day = summarizePromptMix([...cohort(8, "opus", 17_000), ...cohort(2, "sonnet", 111_000)], "2026-08-02");
    expect(day.requests).toBe(10);
    expect(day.meanBytes).toBe((8 * 17_000 + 2 * 111_000) / 10);
    expect(day.medianBytes).toBe(17_000);
  });

  it("groups by captured hash and reports contributions summing to the mean", () => {
    const day = summarizePromptMix([...cohort(3, "opus", 17_000, "aaaa1111"), ...cohort(1, "opus", 111_000, "bbbb2222")], "2026-08-02");
    // A quarter of the requests at 111 KB outweighs three quarters at 17 KB.
    expect(day.cohorts.map((c) => c.hash)).toEqual(["bbbb2222", "aaaa1111"]);
    expect(day.identifiedShare).toBe(1);
    expect(day.cohorts.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(day.meanBytes, 6);
  });

  it("skips malformed entries, so the mean matches the digest's own population", () => {
    const day = summarizePromptMix([...cohort(2, "opus", 17_000), { timestamp: "2026-08-02T14:00:00.000Z" }, null], "2026-08-02");
    expect(day.requests).toBe(2);
    expect(day.meanBytes).toBe(17_000);
  });

  it("separates two hashes that happen to be the same size", () => {
    const day = summarizePromptMix([...cohort(1, "opus", 17_000, "aaaa"), ...cohort(1, "opus", 17_000, "bbbb")], "2026-08-02");
    expect(day.cohorts).toHaveLength(2);
  });

  it("falls back to model and size band for sidecars with no hash", () => {
    const day = summarizePromptMix([...cohort(1, "opus", 108_000), ...cohort(1, "opus", 111_000)], "2026-08-02");
    expect(day.cohorts).toHaveLength(1);
    expect(day.cohorts[0]!.identified).toBe(false);
    expect(day.cohorts[0]!.label).toBe("opus · 32–128 KB");
    expect(day.identifiedShare).toBe(0);
  });

  it("keeps different models apart in the fallback", () => {
    const day = summarizePromptMix([...cohort(1, "opus", 17_000), ...cohort(1, "sonnet", 17_000)], "2026-08-02");
    expect(day.cohorts).toHaveLength(2);
  });

  it("handles a day with no requests", () => {
    const day = summarizePromptMix([], "2026-08-02");
    expect(day).toMatchObject({ requests: 0, meanBytes: 0, medianBytes: 0, identifiedShare: 0, cohorts: [] });
  });
});

describe("promptMixByDay", () => {
  it("buckets by report day, oldest first, skipping unparseable timestamps", () => {
    const days = promptMixByDay([
      ...cohort(1, "opus", 1_000, undefined, "2026-08-02T13:00:00.000Z"),
      ...cohort(2, "opus", 1_000, undefined, "2026-08-01T13:00:00.000Z"),
      ...cohort(1, "opus", 1_000, undefined, "not-a-date"),
    ]);
    expect(days.map((d) => [d.date, d.requests])).toEqual([
      ["2026-08-01", 2],
      ["2026-08-02", 1],
    ]);
  });
});

describe("attributePromptMix", () => {
  it("charges a pure traffic shift to mix and nothing to size", () => {
    const prior = summarizePromptMix([...cohort(8, "opus", 17_000, "a"), ...cohort(2, "opus", 111_000, "b")], "2026-08-01");
    const current = summarizePromptMix([...cohort(5, "opus", 17_000, "a"), ...cohort(5, "opus", 111_000, "b")], "2026-08-02");

    const at = attributePromptMix(prior, current);
    expect(at.deltaBytes).toBeGreaterThan(0);
    expect(at.sizeBytes).toBeCloseTo(0, 6);
    expect(at.mixBytes).toBeCloseTo(at.deltaBytes, 6);
  });

  it("charges a prompt that actually grew to size and nothing to mix", () => {
    const prior = summarizePromptMix(cohort(4, "opus", 17_000, "a"), "2026-08-01");
    const current = summarizePromptMix(cohort(4, "opus", 20_000, "a"), "2026-08-02");

    const at = attributePromptMix(prior, current);
    expect(at.mixBytes).toBeCloseTo(0, 6);
    expect(at.sizeBytes).toBeCloseTo(3_000, 6);
    expect(at.deltaPct).toBeCloseTo((3_000 / 17_000) * 100, 6);
  });

  it("always splits the whole move, with both effects at once", () => {
    const prior = summarizePromptMix([...cohort(8, "opus", 17_000, "a"), ...cohort(2, "opus", 111_000, "b")], "2026-08-01");
    const current = summarizePromptMix([...cohort(3, "opus", 19_000, "a"), ...cohort(6, "opus", 105_000, "b"), ...cohort(1, "opus", 4_000, "c")], "2026-08-02");

    const at = attributePromptMix(prior, current);
    expect(at.mixBytes + at.sizeBytes).toBeCloseTo(at.deltaBytes, 6);
    expect(at.movers.reduce((a, m) => a + m.deltaBytes, 0)).toBeCloseTo(at.deltaBytes, 6);
  });

  it("treats a cohort seen on only one day as pure mix", () => {
    const prior = summarizePromptMix(cohort(4, "opus", 17_000, "a"), "2026-08-01");
    const current = summarizePromptMix([...cohort(3, "opus", 17_000, "a"), ...cohort(1, "opus", 111_000, "b")], "2026-08-02");

    const at = attributePromptMix(prior, current);
    const fresh = at.movers.find((m) => m.key === "b")!;
    expect(fresh.priorShare).toBe(0);
    expect(fresh.sizeBytes).toBeCloseTo(0, 6);
    expect(fresh.mixBytes).toBeCloseTo(0.25 * 111_000, 6);
  });

  it("reports a null percentage when the prior day had no bytes", () => {
    const at = attributePromptMix(summarizePromptMix([], "2026-08-01"), summarizePromptMix(cohort(1, "opus", 17_000, "a"), "2026-08-02"));
    expect(at.deltaPct).toBeNull();
    expect(at.deltaBytes).toBe(17_000);
  });
});

describe("pairPromptRevisions", () => {
  it("pairs a model's vanished prompt with the one that replaced it", () => {
    const prior = summarizePromptMix(cohort(4, "opus", 17_000, "aaaa1111"), "2026-08-01");
    const current = summarizePromptMix(cohort(4, "opus", 21_000, "bbbb2222"), "2026-08-02");

    expect(pairPromptRevisions(prior, current)).toEqual([
      { model: "opus", priorHash: "aaaa1111", hash: "bbbb2222", priorMeanBytes: 17_000, meanBytes: 21_000, deltaBytes: 4_000 },
    ]);
  });

  it("does not pair across models", () => {
    const prior = summarizePromptMix(cohort(2, "opus", 17_000, "aaaa1111"), "2026-08-01");
    const current = summarizePromptMix(cohort(2, "sonnet", 21_000, "bbbb2222"), "2026-08-02");
    expect(pairPromptRevisions(prior, current)).toEqual([]);
  });

  it("ignores a prompt that survived the day", () => {
    const prior = summarizePromptMix(cohort(2, "opus", 17_000, "aaaa1111"), "2026-08-01");
    const current = summarizePromptMix([...cohort(2, "opus", 17_000, "aaaa1111"), ...cohort(1, "opus", 21_000, "bbbb2222")], "2026-08-02");
    expect(pairPromptRevisions(prior, current)).toEqual([]);
  });

  it("leaves unhashed cohorts alone", () => {
    const prior = summarizePromptMix(cohort(2, "opus", 17_000), "2026-08-01");
    const current = summarizePromptMix(cohort(2, "opus", 111_000), "2026-08-02");
    expect(pairPromptRevisions(prior, current)).toEqual([]);
  });

  it("orders several revisions by the size of the move", () => {
    const prior = summarizePromptMix([...cohort(2, "opus", 17_000, "a1"), ...cohort(2, "sonnet", 9_000, "b1")], "2026-08-01");
    const current = summarizePromptMix([...cohort(2, "opus", 18_000, "a2"), ...cohort(2, "sonnet", 40_000, "b2")], "2026-08-02");
    expect(pairPromptRevisions(prior, current).map((r) => r.model)).toEqual(["sonnet", "opus"]);
  });
});
