import { describe, expect, it } from "vitest";
import {
  isEvictable,
  logFileDay,
  planRetention,
  resolveRetentionDays,
  resolveToday,
  shiftDate,
  type RetentionCorpus,
} from "../src/retention.js";

/**
 * Every case here is a listing rather than a directory: the planner is pure, and
 * no test should be able to delete a real log to prove it works.
 */

const TODAY = "2026-08-02";

/** The three files one captured request writes, as the proxy names them. */
function triple(stem: string, bytes = 100): { name: string; bytes: number }[] {
  return [
    { name: `${stem}.audit.json`, bytes },
    { name: `${stem}.md`, bytes: bytes * 10 },
    { name: `${stem}.request.txt`, bytes: bytes * 20 },
  ];
}

function corpus(over: Partial<RetentionCorpus> = {}): RetentionCorpus {
  return { live: [], archive: [], ...over };
}

function plan(c: RetentionCorpus, retentionDays = 30) {
  return planRetention({ corpus: c, today: TODAY, retentionDays });
}

describe("archiving", () => {
  it("moves a past day out of the live directory and leaves today's alone", () => {
    const p = plan(
      corpus({
        live: [...triple("2026-08-01T10-00-00-000_anthropic"), ...triple("2026-08-02T10-00-00-000_anthropic")],
      }),
    );

    expect(p.archive.moves.map((m) => m.name)).toEqual([
      "2026-08-01T10-00-00-000_anthropic.audit.json",
      "2026-08-01T10-00-00-000_anthropic.md",
      "2026-08-01T10-00-00-000_anthropic.request.txt",
    ]);
    expect(p.archive.days).toEqual(["2026-08-01"]);
  });

  it("leaves a tomorrow-stamped file in place — UTC runs ahead of the reporting day", () => {
    const p = plan(corpus({ live: triple("2026-08-03T02-00-00-000_anthropic") }));
    expect(p.archive.moves).toEqual([]);
  });

  it("never moves a name that carries no date, which is what protects the authored state", () => {
    const p = plan(
      corpus({
        live: [
          { name: "suggestion-status.json", bytes: 10 },
          { name: "claude-proxy.db", bytes: 999 },
          { name: "runs.jsonl", bytes: 10 },
        ],
      }),
    );
    expect(p.archive.moves).toEqual([]);
    expect(p.evict.files).toEqual([]);
  });
});

describe("eviction", () => {
  const stem = "2026-06-01T10-00-00-000_anthropic";

  it("removes the bodies of an expired day and keeps its sidecar", () => {
    const p = plan(corpus({ archive: [{ day: "2026-06-01", files: triple(stem) }] }));

    expect(p.cutoff).toBe("2026-07-03");
    expect(p.evict.files.map((f) => f.name)).toEqual([`${stem}.md`, `${stem}.request.txt`]);
    expect(p.evict.files.some((f) => f.name.endsWith(".audit.json"))).toBe(false);
    // 10× + 20× the sidecar's 100 bytes.
    expect(p.evict.bytes).toBe(3000);
  });

  it("spares a day inside the window", () => {
    const p = plan(corpus({ archive: [{ day: "2026-07-13", files: triple("2026-07-13T10-00-00-000_anthropic") }] }));
    expect(p.evict.files).toEqual([]);
  });

  it("treats the cutoff day itself as still retained", () => {
    const onCutoff = shiftDate(TODAY, -30);
    const p = plan(corpus({ archive: [{ day: onCutoff, files: triple(`${onCutoff}T10-00-00-000_anthropic`) }] }));
    expect(p.evict.files).toEqual([]);
  });

  it("evicts a body archived by this same run into an already-expired day", () => {
    // Archiving and eviction happen in one pass, so a body that lands in an
    // expired day must not survive until tomorrow's run.
    const p = plan(corpus({ live: triple(stem) }));
    expect(p.archive.days).toEqual(["2026-06-01"]);
    expect(p.evict.files.map((f) => f.name)).toEqual([`${stem}.md`, `${stem}.request.txt`]);
  });

  it("never evicts from the live directory — only archived days are candidates", () => {
    // The same expired stem, but with archiving disabled by pretending it is today's.
    const p = plan(corpus({ live: triple(`${TODAY}T10-00-00-000_anthropic`) }), 0);
    expect(p.archive.moves).toEqual([]);
    expect(p.evict.files).toEqual([]);
  });

  it("leaves anything that is not a body alone", () => {
    const p = plan(
      corpus({
        archive: [
          {
            day: "2026-06-01",
            files: [
              { name: `${stem}.audit.json`, bytes: 1 },
              { name: "digest.json", bytes: 1 },
              { name: "notes.txt", bytes: 1 },
            ],
          },
        ],
      }),
    );
    expect(p.evict.files).toEqual([]);
  });
});

describe("helpers", () => {
  it("reads the retention window off the environment, falling back to 30", () => {
    expect(resolveRetentionDays({ RETENTION_DAYS: "7" })).toBe(7);
    expect(resolveRetentionDays({})).toBe(30);
    expect(resolveRetentionDays({ RETENTION_DAYS: "nonsense" })).toBe(30);
    expect(resolveRetentionDays({ RETENTION_DAYS: "-5" })).toBe(30);
  });

  it("resolves today in the configured zone", () => {
    // 00:30Z on the 3rd is still the 2nd in Eastern time.
    const at = new Date("2026-08-03T00:30:00.000Z");
    expect(resolveToday({ TIMEZONE: "America/Toronto" }, at)).toBe("2026-08-02");
    expect(resolveToday({ TIMEZONE: "UTC" }, at)).toBe("2026-08-03");
  });

  it("classifies filenames", () => {
    expect(logFileDay("2026-08-01T10-00-00-000_anthropic.md")).toBe("2026-08-01");
    expect(logFileDay("suggestion-status.json")).toBeNull();
    expect(isEvictable("x.audit.json")).toBe(false);
    expect(isEvictable("x.md")).toBe(true);
    expect(isEvictable("x.request.txt")).toBe(true);
  });
});
