import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readArchivedDay, readSidecars, today } from "../src/logs.js";

/** A sidecar whose filename prefix is its UTC instant, exactly as the proxy writes it. */
function nameFor(iso: string): string {
  return `${iso.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic.audit.json`;
}

async function writeSidecar(dir: string, iso: string): Promise<void> {
  await writeFile(path.join(dir, nameFor(iso)), JSON.stringify({ timestamp: iso }), "utf8");
}

// 21:30 EDT on the 15th, but 01:30Z on the 16th — the case that used to be
// counted a day early.
const EVENING_15TH = "2026-07-16T01:30:00.000Z";
const MORNING_15TH = "2026-07-15T14:00:00.000Z";
const MORNING_16TH = "2026-07-16T14:00:00.000Z";

let logDir: string;

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), "logs-day-"));
  for (const iso of [MORNING_15TH, EVENING_15TH, MORNING_16TH]) await writeSidecar(logDir, iso);
});

describe("readSidecars date filtering", () => {
  it("claims an evening request whose filename lands on the next UTC day", async () => {
    const { sidecars, files } = await readSidecars(logDir, { date: "2026-07-15" });
    expect(files).toBe(2);
    expect(sidecars.map((s) => (s as { timestamp: string }).timestamp).sort()).toEqual(
      [MORNING_15TH, EVENING_15TH].sort(),
    );
  });

  it("does not leak that request into the following day", async () => {
    const { sidecars, files } = await readSidecars(logDir, { date: "2026-07-16" });
    expect(files).toBe(1);
    expect((sidecars[0] as { timestamp: string }).timestamp).toBe(MORNING_16TH);
  });

  it("excludes pre-window evenings from a `since` range", async () => {
    const { sidecars } = await readSidecars(logDir, { since: "2026-07-16" });
    expect(sidecars.map((s) => (s as { timestamp: string }).timestamp)).toEqual([MORNING_16TH]);
  });
});

describe("readArchivedDay", () => {
  it("merges the two UTC folders a reporting day straddles", async () => {
    const archiveRoot = await mkdtemp(path.join(tmpdir(), "logs-archive-"));
    for (const [folder, iso] of [
      ["2026-07-15", MORNING_15TH],
      ["2026-07-16", EVENING_15TH],
      ["2026-07-16", MORNING_16TH],
    ] as const) {
      const dir = path.join(archiveRoot, "archive", folder);
      await mkdir(dir, { recursive: true });
      await writeSidecar(dir, iso);
    }

    const { sidecars, files } = await readArchivedDay(archiveRoot, "2026-07-15");
    expect(files).toBe(2);
    expect(sidecars.map((s) => (s as { timestamp: string }).timestamp).sort()).toEqual(
      [MORNING_15TH, EVENING_15TH].sort(),
    );
  });
});

describe("today", () => {
  it("reports the reporting-zone day, not the UTC one", () => {
    expect(today(new Date(EVENING_15TH))).toBe("2026-07-15");
  });
});
