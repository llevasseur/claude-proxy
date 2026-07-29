import { describe, expect, it } from "vitest";
import type { SessionBucket } from "../src/suggestions.js";
import {
  applySuggestionStatusUpdates,
  countSuggestionRecurrences,
  countSuggestionStatuses,
  emptySuggestionStatusStore,
  parseBucketRange,
  parseSuggestionStatusStore,
  parseSuggestionStatusUpdates,
  ruleResolutions,
  suggestionRecurrence,
  suggestionStatusOf,
  suggestionStatusRows,
} from "../src/suggestion-status.js";

/** A bucket carrying just what the status join reads off it. */
function bucket(index: number, ids: string[], span?: { first: string; last: string }): SessionBucket {
  const from = (index - 1) * 10 + 1;
  return {
    index,
    from,
    to: from + 9,
    label: `${from}–${from + 9}`,
    startedFirst: span?.first ?? null,
    startedLast: span?.last ?? null,
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

  it("leaves detail out unless asked, so scanning a wide range stays lean", () => {
    const [lean] = suggestionStatusRows(buckets, store, { buckets: [1] });
    expect(lean?.detail).toBeUndefined();
    expect(lean?.sources).toBeUndefined();
    const [full] = suggestionStatusRows(buckets, store, { buckets: [1], detail: true });
    expect(full).toMatchObject({ detail: "", evidence: "", sources: [] });
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

// A window is frozen, so "the rule still trips" only means something once you know
// whether the sessions it tripped on were recorded before or after the fix landed.
describe("recurrence against a dated fix", () => {
  const fixedAt = new Date("2026-07-20T00:00:00.000Z");
  const before = { first: "2026-07-01T00:00:00.000Z", last: "2026-07-05T00:00:00.000Z" };
  const straddling = { first: "2026-07-15T00:00:00.000Z", last: "2026-07-25T00:00:00.000Z" };
  const after = { first: "2026-07-22T00:00:00.000Z", last: "2026-07-28T00:00:00.000Z" };

  const dated = [
    bucket(1, ["serial-discovery"], before),
    bucket(2, ["serial-discovery"], straddling),
    bucket(3, ["serial-discovery", "redundant-reads"], after),
  ];
  const fixed = applySuggestionStatusUpdates(
    emptySuggestionStatusStore(),
    [{ bucket: 1, id: "serial-discovery", status: "done", note: "PR #84" }],
    fixedAt,
  );

  it("carries one window's mark across every window, dated", () => {
    const rows = suggestionStatusRows(dated, fixed);
    expect(rows.map((r) => `${r.bucket}/${r.id}:${r.recurrence}`)).toEqual([
      "1/serial-discovery:historical",
      "2/serial-discovery:mixed",
      "3/serial-discovery:regressed",
      "3/redundant-reads:none",
    ]);
  });

  it("names the claim a regression broke, so it is not mistaken for a new finding", () => {
    const [regressed] = suggestionStatusRows(dated, fixed, { buckets: [3], recurrences: ["regressed"] });
    expect(regressed).toMatchObject({ bucket: 3, id: "serial-discovery", status: "pending", recurrence: "regressed" });
    expect(regressed?.resolved).toEqual({ bucket: 1, updated: fixedAt.toISOString(), note: "PR #84" });
  });

  it("leaves an unclaimed rule alone — no recurrence, no claim", () => {
    const [row] = suggestionStatusRows(dated, fixed, { buckets: [3], statuses: ["pending"], recurrences: ["none"] });
    expect(row).toMatchObject({ id: "redundant-reads", recurrence: "none" });
    expect(row?.resolved).toBeUndefined();
  });

  it("treats skipped as a decision, not a claim, so nothing regresses off it", () => {
    const skipped = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [{ bucket: 1, id: "serial-discovery", status: "skipped" }],
      fixedAt,
    );
    expect(ruleResolutions(skipped).size).toBe(0);
    expect(suggestionStatusRows(dated, skipped).every((r) => r.recurrence === "none")).toBe(true);
  });

  it("ignores an undated flag rather than inventing a regression from it", () => {
    const undated = parseSuggestionStatusStore({
      version: 1,
      buckets: { "1": { "serial-discovery": { status: "done" } } },
    });
    expect(undated.buckets["1"]?.["serial-discovery"]?.updated).toBe("");
    expect(ruleResolutions(undated).size).toBe(0);
    expect(suggestionStatusRows(dated, undated).every((r) => r.recurrence === "none")).toBe(true);
  });

  it("cannot place a window whose sessions carry no start", () => {
    const rows = suggestionStatusRows([bucket(1, ["serial-discovery"])], fixed);
    expect(rows[0]?.recurrence).toBe("none");
  });

  it("keeps the most recent done when several windows carry one", () => {
    const again = applySuggestionStatusUpdates(
      fixed,
      [{ bucket: 2, id: "serial-discovery", status: "done", note: "PR #91" }],
      new Date("2026-07-27T00:00:00.000Z"),
    );
    expect(ruleResolutions(again).get("serial-discovery")).toEqual({
      bucket: 2,
      updated: "2026-07-27T00:00:00.000Z",
      note: "PR #91",
    });
    // Bucket 3 ran 07-22 → 07-28, so it now straddles the later claim rather than following it.
    const rows = suggestionStatusRows(dated, again, { buckets: [3], recurrences: ["mixed"] });
    expect(rows.map((r) => r.id)).toEqual(["serial-discovery"]);
  });

  it("counts a session recorded at the moment of the mark as before it", () => {
    const claim = { bucket: 1, updated: fixedAt.toISOString() };
    expect(suggestionRecurrence({ startedFirst: before.first, startedLast: claim.updated }, claim)).toBe("historical");
    expect(suggestionRecurrence({ startedFirst: claim.updated, startedLast: after.last }, claim)).toBe("regressed");
    expect(suggestionRecurrence({ startedFirst: before.first, startedLast: after.last }, undefined)).toBe("none");
  });

  it("counts each recurrence state over the rows it returned", () => {
    expect(countSuggestionRecurrences(suggestionStatusRows(dated, fixed))).toEqual({
      none: 1,
      historical: 1,
      mixed: 1,
      regressed: 1,
    });
  });

  it("filters out the windows a fix predates, which is what leaves only actionable work", () => {
    const rows = suggestionStatusRows(dated, fixed, { recurrences: ["none", "mixed", "regressed"] });
    expect(rows.map((r) => `${r.bucket}/${r.id}`)).toEqual([
      "2/serial-discovery",
      "3/serial-discovery",
      "3/redundant-reads",
    ]);
  });
});
