import { describe, expect, it } from "vitest";
import type { SessionBucket } from "../src/suggestions.js";
import {
  applySuggestionStatusUpdates,
  countSuggestionStatuses,
  emptySuggestionStatusStore,
  parseBucketRange,
  parseSuggestionStatusStore,
  parseSuggestionStatusUpdates,
  suggestionStatusOf,
  suggestionStatusRows,
} from "../src/suggestion-status.js";

/** A bucket carrying just what the status join reads off it. */
function bucket(index: number, ids: string[]): SessionBucket {
  const from = (index - 1) * 10 + 1;
  return {
    index,
    from,
    to: from + 9,
    label: `${from}–${from + 9}`,
    startedFirst: null,
    startedLast: null,
    threadIds: [],
    stats: {
      sessions: 10,
      tasks: 0,
      decisions: 0,
      tools: 0,
      errors: 0,
      toolsPerTask: 0,
      unfinishedTasks: 0,
      discoveryRatio: 0,
      topTools: [],
    },
    suggestions: ids.map((id) => ({ id, severity: "warn" as const, title: `Fix ${id}`, detail: "", evidence: "", sources: [] })),
  };
}

const now = new Date("2026-07-26T12:00:00.000Z");

describe("parseBucketRange", () => {
  it("reads a single bucket, a list, a span, and a mix", () => {
    expect(parseBucketRange("9")).toEqual([9]);
    expect(parseBucketRange("2,3,9")).toEqual([2, 3, 9]);
    expect(parseBucketRange("2-5")).toEqual([2, 3, 4, 5]);
    expect(parseBucketRange(" 2 - 4 , 9 ")).toEqual([2, 3, 4, 9]);
  });

  it("accepts the en dash the bucket labels use", () => {
    expect(parseBucketRange("2–4")).toEqual([2, 3, 4]);
  });

  it("de-duplicates overlapping parts", () => {
    expect(parseBucketRange("2-4,3,4")).toEqual([2, 3, 4]);
  });

  it("refuses a typo rather than running over nothing", () => {
    expect(() => parseBucketRange("abc")).toThrow(/invalid bucket range/);
    expect(() => parseBucketRange("0")).toThrow(/buckets start at 1/);
    expect(() => parseBucketRange("9-2")).toThrow(/end is before start/);
    expect(() => parseBucketRange("")).toThrow(/empty/);
  });
});

describe("store", () => {
  it("defaults every suggestion to pending", () => {
    expect(suggestionStatusOf(emptySuggestionStatusStore(), 3, "serial-discovery").status).toBe("pending");
  });

  it("records a flag without mutating the input store", () => {
    const before = emptySuggestionStatusStore();
    const after = applySuggestionStatusUpdates(before, [{ bucket: 3, id: "serial-discovery", status: "done", note: "PR #71" }], now);
    expect(before.buckets).toEqual({});
    expect(suggestionStatusOf(after, 3, "serial-discovery")).toEqual({
      status: "done",
      updated: now.toISOString(),
      note: "PR #71",
    });
  });

  it("keeps an existing note when a later update omits one, and clears it on an empty note", () => {
    const done = applySuggestionStatusUpdates(emptySuggestionStatusStore(), [{ bucket: 1, id: "a", status: "done", note: "PR #1" }], now);
    const reflagged = applySuggestionStatusUpdates(done, [{ bucket: 1, id: "a", status: "skipped" }], now);
    expect(suggestionStatusOf(reflagged, 1, "a").note).toBe("PR #1");
    const cleared = applySuggestionStatusUpdates(reflagged, [{ bucket: 1, id: "a", status: "skipped", note: "" }], now);
    expect(suggestionStatusOf(cleared, 1, "a").note).toBeUndefined();
  });

  it("stores nothing for pending, so the file only carries decisions", () => {
    const done = applySuggestionStatusUpdates(emptySuggestionStatusStore(), [{ bucket: 1, id: "a", status: "done" }], now);
    const back = applySuggestionStatusUpdates(done, [{ bucket: 1, id: "a", status: "pending" }], now);
    expect(back.buckets).toEqual({});
  });

  it("survives a corrupt file by dropping only what is malformed", () => {
    const parsed = parseSuggestionStatusStore({
      version: 1,
      buckets: {
        "1": { good: { status: "done", updated: "2026-07-01T00:00:00.000Z" }, bad: { status: "nonsense" }, worse: 7 },
        notANumber: { a: { status: "done" } },
        "2": "nope",
      },
    });
    expect(Object.keys(parsed.buckets)).toEqual(["1"]);
    expect(Object.keys(parsed.buckets["1"] ?? {})).toEqual(["good"]);
  });

  it("reads junk as empty rather than throwing", () => {
    expect(parseSuggestionStatusStore(null).buckets).toEqual({});
    expect(parseSuggestionStatusStore("nope").buckets).toEqual({});
    expect(parseSuggestionStatusStore([1, 2]).buckets).toEqual({});
  });
});

describe("suggestionStatusRows", () => {
  const buckets = [bucket(3, ["serial-discovery", "redundant-reads"]), bucket(1, ["blocked-guardrails"]), bucket(2, ["high-tool-churn"])];
  const store = applySuggestionStatusUpdates(emptySuggestionStatusStore(), [{ bucket: 3, id: "serial-discovery", status: "done" }], now);

  it("lists oldest bucket first, whatever order the buckets came in", () => {
    expect(suggestionStatusRows(buckets, store).map((r) => `${r.bucket}/${r.id}`)).toEqual([
      "1/blocked-guardrails",
      "2/high-tool-churn",
      "3/serial-discovery",
      "3/redundant-reads",
    ]);
  });

  it("filters to a range and to a flag, which is how pending work is found", () => {
    const rows = suggestionStatusRows(buckets, store, { buckets: [2, 3], statuses: ["pending"] });
    expect(rows.map((r) => `${r.bucket}/${r.id}`)).toEqual(["2/high-tool-churn", "3/redundant-reads"]);
  });

  it("carries the flag and its timestamp, and omits both while pending", () => {
    const [done] = suggestionStatusRows(buckets, store, { buckets: [3], statuses: ["done"] });
    expect(done).toMatchObject({ bucket: 3, id: "serial-discovery", status: "done", updated: now.toISOString(), label: "21–30" });
    const [pending] = suggestionStatusRows(buckets, store, { buckets: [1] });
    expect(pending?.status).toBe("pending");
    expect(pending?.updated).toBeUndefined();
  });

  it("counts the flags it returned", () => {
    expect(countSuggestionStatuses(suggestionStatusRows(buckets, store))).toEqual({ pending: 3, done: 1, skipped: 0 });
  });
});

describe("parseSuggestionStatusUpdates", () => {
  it("accepts a well-formed batch", () => {
    expect(parseSuggestionStatusUpdates([{ bucket: 9, id: " serial-discovery ", status: "done", note: "PR #71" }])).toEqual([
      { bucket: 9, id: "serial-discovery", status: "done", note: "PR #71" },
    ]);
  });

  it("names the first thing wrong", () => {
    expect(() => parseSuggestionStatusUpdates("nope")).toThrow(/must be an array/);
    expect(() => parseSuggestionStatusUpdates([])).toThrow(/must not be empty/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 0, id: "a", status: "done" }])).toThrow(/updates\[0\].bucket/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 1, id: "", status: "done" }])).toThrow(/updates\[0\].id/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 1, id: "a", status: "finished" }])).toThrow(/updates\[0\].status/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 1, id: "a", status: "done", note: 7 }])).toThrow(/updates\[0\].note/);
  });
});
