import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const [concept] = parseConceptStore(JSON.stringify({ term: "bare", savedAt: LINES[0].savedAt }));
    expect(concept).toEqual({ term: "bare", sentence: "", field: "", skills: [], savedAt: LINES[0].savedAt });
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
