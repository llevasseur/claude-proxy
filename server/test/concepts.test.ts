import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConcept, buildConcepts } from "../src/api.js";
import { conceptStorePath, parseConceptStore, readConcepts } from "../src/concepts.js";
import { ingestConcepts } from "../src/db/ingest-concepts.js";
import { openDb } from "../src/db/open.js";
import { dbSource, fileSource } from "../src/db/source.js";

/**
 * `logs/concepts.jsonl` is the source of truth and the `concept` table is a view of
 * it. The tests that matter are the ones that keep that true: a rebuild from an empty
 * database matches the file, and both backings answer a read identically.
 */

const LINES = [
  {
    term: "carousel",
    sentence: "A carousel shows one image at a time and dims its neighbours.",
    field: "UI component vocabulary",
    skills: ["animation-vocabulary", "find-skills"],
    savedAt: "2026-08-01T13:32:28.675Z",
  },
  {
    term: "watermark",
    sentence: "A watermark records how far a store was read so the next pass can skip it.",
    field: "Ingestion",
    skills: ["sqlite"],
    savedAt: "2026-08-02T09:00:00.000Z",
  },
];

let logDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), "concepts-"));
  db = openDb(logDir);
});

afterEach(async () => {
  db?.close();
  await rm(logDir, { recursive: true, force: true });
});

async function writeStore(records: unknown[], trailer = ""): Promise<void> {
  await writeFile(conceptStorePath(logDir), records.map((r) => JSON.stringify(r)).join("\n") + "\n" + trailer, "utf8");
}

describe("parseConceptStore", () => {
  it("keeps every line, in file order, including a term taught twice", () => {
    const text = [LINES[0], LINES[1], LINES[0]].map((r) => JSON.stringify(r)).join("\n");
    expect(parseConceptStore(text).map((c) => c.term)).toEqual(["carousel", "watermark", "carousel"]);
  });

  it("skips blank lines, a torn final line, and records that are not concepts", () => {
    const text = [JSON.stringify(LINES[0]), "", "{\"nope\": 1}", JSON.stringify(LINES[1]), '{"term":"tor'].join("\n");
    expect(parseConceptStore(text).map((c) => c.term)).toEqual(["carousel", "watermark"]);
  });

  it("fills in the optional fields so the page never renders undefined", () => {
    const savedAt = LINES[0]?.savedAt;
    const [concept] = parseConceptStore(JSON.stringify({ term: "bare", savedAt }));
    expect(concept).toEqual({ term: "bare", sentence: "", field: "", skills: [], savedAt });
  });
});

describe("readConcepts", () => {
  it("is empty, not an error, when nothing has been taught", async () => {
    expect(await readConcepts(logDir)).toEqual([]);
  });

  it("returns the newest concept first", async () => {
    await writeStore(LINES);
    expect((await readConcepts(logDir)).map((c) => c.term)).toEqual(["watermark", "carousel"]);
  });
});

describe("ingestConcepts", () => {
  it("rebuilds the whole table from the file — `rm db && ingest` is a total recovery", async () => {
    await writeStore(LINES);
    const first = await ingestConcepts(db, logDir);
    expect(first).toMatchObject({ concepts: 2, parsed: true, deleted: 0 });
    expect((db.prepare("SELECT count(*) c FROM concept_skill").get() as { c: number }).c).toBe(3);

    // A second pass over an untouched store is skipped on its watermark.
    const second = await ingestConcepts(db, logDir);
    expect(second).toMatchObject({ concepts: 2, parsed: false });

    // An appended line is picked up, and the rows are replaced rather than doubled.
    await writeStore([...LINES, { ...LINES[0], term: "carousel", savedAt: "2026-08-03T00:00:00.000Z" }]);
    const third = await ingestConcepts(db, logDir);
    expect(third).toMatchObject({ concepts: 3, parsed: true });
    expect((db.prepare("SELECT count(*) c FROM concept").get() as { c: number }).c).toBe(3);
    // The skills went with them: without the cascade these would have accumulated.
    expect((db.prepare("SELECT count(*) c FROM concept_skill").get() as { c: number }).c).toBe(5);
  });

  it("drops the rows and its watermark when the store is gone", async () => {
    await writeStore(LINES);
    await ingestConcepts(db, logDir);
    await rm(conceptStorePath(logDir));

    expect(await ingestConcepts(db, logDir)).toMatchObject({ concepts: 0, deleted: 2 });
    expect((db.prepare("SELECT count(*) c FROM concept").get() as { c: number }).c).toBe(0);
    const mark = db.prepare("SELECT path FROM file_watermark WHERE path = ?").get("concepts.jsonl");
    expect(mark).toBeUndefined();
  });
});

/** A record carrying every field `/teach` learned to write after the first ones. */
const DETAILED = {
  term: "shadcn/ui",
  sentence: "A copy-in component collection built on Radix primitives.",
  field: "React UI",
  skills: ["find-skills", "shadcn-ui"],
  savedAt: "2026-08-05T10:00:00.000Z",
  notes: "Components are vendored into the repo rather than installed.",
  tips: ["Run the CLI once per component."],
  sources: ["https://ui.shadcn.com"],
  surfacedSkills: ["find-skills", "radix-primitives"],
};

describe("optional detail fields", () => {
  it("are absent, not empty, on a record that never carried them", () => {
    const [concept] = parseConceptStore(JSON.stringify(LINES[0]));
    expect(concept).not.toHaveProperty("notes");
    expect(concept).not.toHaveProperty("tips");
    expect(concept).not.toHaveProperty("sources");
    expect(concept).not.toHaveProperty("surfacedSkills");
  });

  it("survive the round trip through the table", async () => {
    await writeStore([DETAILED]);
    await ingestConcepts(db, logDir);
    expect(await dbSource(db).readConcepts(logDir)).toEqual(await fileSource.readConcepts(logDir));

    const items = db.prepare("SELECT kind, item FROM concept_item ORDER BY kind, item_ord").all() as unknown as Array<{
      kind: string;
      item: string;
    }>;
    // The store's own words, meta-skill and all — only the served answer is filtered.
    expect(items).toEqual([
      { kind: "source", item: "https://ui.shadcn.com" },
      { kind: "surfaced_skill", item: "find-skills" },
      { kind: "surfaced_skill", item: "radix-primitives" },
      { kind: "tip", item: "Run the CLI once per component." },
    ]);
  });
});

describe("ord", () => {
  it("is the line in the file, not the position on the page", async () => {
    await writeStore(LINES);
    // The page shows `watermark` first, but it is the store's *second* line.
    expect((await readConcepts(logDir)).map((c) => [c.term, c.ord])).toEqual([
      ["watermark", 1],
      ["carousel", 0],
    ]);
  });
});

describe("buildConcepts", () => {
  it("drops the meta-skills from both skill lists", async () => {
    await writeStore([DETAILED]);
    const { concepts } = await buildConcepts(logDir);
    expect(concepts[0]?.skills).toEqual(["shadcn-ui"]);
    expect(concepts[0]?.surfacedSkills).toEqual(["radix-primitives"]);
  });

  it("leaves an unrecorded surfaced-skill list absent rather than empty", async () => {
    await writeStore(LINES);
    const { concepts } = await buildConcepts(logDir);
    expect(concepts[0]).not.toHaveProperty("surfacedSkills");
  });
});

describe("buildConcept", () => {
  it("finds the record by its line, whichever backing serves it", async () => {
    await writeStore(LINES);
    await ingestConcepts(db, logDir);
    for (const source of [fileSource, dbSource(db)]) {
      const { concept, meta } = await buildConcept(logDir, 0, source);
      expect(concept.term).toBe("carousel");
      // Filtered here too — the list and the detail page must not disagree.
      expect(concept.skills).toEqual(["animation-vocabulary"]);
      expect(meta.total).toBe(2);
    }
  });

  it("says so when the store has no such line", async () => {
    await writeStore(LINES);
    await expect(buildConcept(logDir, 9)).rejects.toThrow("concept not found: 9");
  });
});

describe("both backings", () => {
  it("answer a concepts read identically", async () => {
    await writeStore(LINES);
    await ingestConcepts(db, logDir);
    expect(await dbSource(db).readConcepts(logDir)).toEqual(await fileSource.readConcepts(logDir));
  });

  it("fall back to the file when a concept landed after the last ingest", async () => {
    await writeStore(LINES);
    await ingestConcepts(db, logDir);
    await writeStore([...LINES, { ...LINES[1], term: "fresh", savedAt: "2026-08-04T00:00:00.000Z" }]);

    // The table is still two rows behind; the read must not serve the stale view.
    expect((await dbSource(db).readConcepts(logDir)).map((c) => c.term)).toEqual(["fresh", "watermark", "carousel"]);
  });
});
