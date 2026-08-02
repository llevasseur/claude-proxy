import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ingest } from "../src/db/ingest.js";
import { openDb } from "../src/db/open.js";
import { dbSource, fileSource } from "../src/db/source.js";
import { resolveLogDir } from "../src/logs.js";
import {
  archivedDays,
  NORMALIZATIONS,
  PARITY_ROUTES,
  resetCaches,
  runCase,
  type ParityContext,
} from "../src/parity.js";
import { resolveUsageLimits } from "../src/usage-config.js";

/**
 * The parity harness in anger: every wired route, replayed against the same
 * corpus through the file scan and through SQLite, asserting the full JSON is
 * identical — not a row count, not a summary.
 *
 * Two corpora. The synthetic one runs everywhere and is built to be nasty: a
 * legacy sidecar with no session/skim/rateLimit, a file that will not parse, a
 * structurally invalid one, a request whose bodies have been evicted, and two
 * requests sharing a tool name so the digest's tie-breaking order is exercised.
 * The real one is whatever `logs/archive` holds on this machine, which is the
 * only place the shape of a year of real traffic can be checked.
 */

/** A sidecar filename prefix that is its UTC instant, exactly as the proxy writes it. */
function stemFor(iso: string): string {
  return `${iso.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic`;
}

interface SidecarOpts {
  model?: string;
  tools?: Array<{ name: string; bytes: number; estTokens: number }>;
  session?: Record<string, string | null> | null;
  skim?: Record<string, unknown> | null;
  rateLimit?: Record<string, string> | null;
  realInput?: number;
}

function sidecarBody(iso: string, opts: SidecarOpts = {}): Record<string, unknown> {
  const tools = opts.tools ?? [{ name: "Bash", bytes: 900, estTokens: 225 }];
  const body: Record<string, unknown> = {
    timestamp: iso,
    model: opts.model ?? "claude-opus-5",
    endpoint: "/v1/messages",
    statusCode: 200,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 400,
      cacheCreation: 25,
      realInput: opts.realInput ?? 525,
    },
    request: { toolCount: tools.length, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools,
  };
  if (opts.session !== null) {
    body.session = opts.session ?? {
      sessionId: "s-1",
      app: "claude-code",
      userAgent: "claude-cli/2.0",
      account: "someone@example.com",
      metadataSessionId: "m-1",
      deviceId: "d-1",
    };
  }
  if (opts.skim !== null) {
    body.skim = opts.skim ?? { enabled: true, servedFromCache: false, savedInputTokens: 0, cacheKey: null };
  }
  if (opts.rateLimit !== null) {
    body.rateLimit = opts.rateLimit ?? {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-remaining": "40000",
    };
  }
  return body;
}

/** Write the audit sidecar plus the `.md` / `.request.txt` blobs beside it. */
async function writeTriple(dir: string, iso: string, opts: SidecarOpts & { blobs?: boolean } = {}): Promise<void> {
  const stem = stemFor(iso);
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(sidecarBody(iso, opts)), "utf8");
  if (opts.blobs !== false) {
    await writeFile(path.join(dir, `${stem}.md`), `# ${iso}\n`, "utf8");
    await writeFile(path.join(dir, `${stem}.request.txt`), JSON.stringify({ messages: [] }), "utf8");
  }
}

async function writeRaw(dir: string, iso: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), contents, "utf8");
}

/**
 * A corpus with two archived days and a live day, carrying every awkward case
 * the real logs contain.
 */
async function buildCorpus(): Promise<string> {
  const logDir = await mkdtemp(path.join(tmpdir(), "parity-"));
  const dayOne = path.join(logDir, "archive", "2026-07-15");
  const dayTwo = path.join(logDir, "archive", "2026-07-16");
  await mkdir(dayOne, { recursive: true });
  await mkdir(dayTwo, { recursive: true });

  await writeTriple(dayOne, "2026-07-15T14:00:00.000Z");
  // Same tool name as the request above, different byte weight — the digest
  // accumulates them into one row, and ties are broken by first appearance.
  await writeTriple(dayOne, "2026-07-15T15:00:00.000Z", {
    tools: [
      { name: "Bash", bytes: 900, estTokens: 225 },
      { name: "Read", bytes: 900, estTokens: 300 },
    ],
    model: "claude-sonnet-5",
  });
  // A legacy sidecar: no session, no skim, no rate-limit headers.
  await writeTriple(dayOne, "2026-07-15T16:00:00.000Z", { session: null, skim: null, rateLimit: null });
  // Retention took the bodies but the metrics survive.
  await writeTriple(dayOne, "2026-07-15T17:00:00.000Z", { blobs: false });
  // Not JSON at all.
  await writeRaw(dayOne, "2026-07-15T18:00:00.000Z", "{ this is not json");
  // JSON, but not an audit sidecar — the digest counts it under `skipped`.
  await writeRaw(dayOne, "2026-07-15T19:00:00.000Z", JSON.stringify({ timestamp: "2026-07-15T19:00:00.000Z", nope: 1 }));
  // 21:30 Eastern on the 15th is 01:30Z on the 16th, so it is filed under the
  // next UTC folder while belonging to the 15th's reporting day.
  await writeTriple(dayTwo, "2026-07-16T01:30:00.000Z");
  await writeTriple(dayTwo, "2026-07-16T14:00:00.000Z", { model: "claude-haiku-4-5-20251001" });

  // A session all-null but present, which is a different fact from absent.
  await writeTriple(logDir, "2026-07-17T14:00:00.000Z", {
    session: { sessionId: null, app: null, userAgent: null, account: null, metadataSessionId: null, deviceId: null },
  });
  return logDir;
}

/** Replay every registered route's every case, and return the ones that differed. */
async function mismatches(ctx: ParityContext, db: DatabaseSync): Promise<string[]> {
  const fromDb = dbSource(db);
  const out: string[] = [];
  let cases = 0;
  resetCaches();
  for (const route of PARITY_ROUTES) {
    for (const testCase of await route.cases(ctx)) {
      cases += 1;
      const result = await runCase(route, testCase, fileSource, fromDb);
      if (result.diff) {
        out.push(
          `${result.label} differs at ${result.diff.path}: ` +
            `files=${JSON.stringify(result.diff.files)} db=${JSON.stringify(result.diff.db)}`,
        );
      }
    }
  }
  expect(cases, "the harness replayed nothing, so it proved nothing").toBeGreaterThan(0);
  return out;
}

describe("route parity over a synthetic corpus", () => {
  let ctx: ParityContext;
  let db: DatabaseSync;

  beforeAll(async () => {
    const logDir = await buildCorpus();
    ctx = { logDir, limits: resolveUsageLimits({}) };
    db = openDb(logDir);
    await ingest(db, logDir);
  });

  afterAll(() => {
    db?.close();
  });

  it("ingests every sidecar, and files that are not sidecars separately", () => {
    expect((db.prepare("SELECT count(*) c FROM request").get() as { c: number }).c).toBe(7);
    expect((db.prepare("SELECT count(*) c FROM request_skipped").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT count(*) c FROM request WHERE blob_evicted = 1").get() as { c: number }).c).toBe(1);
    // Absent and all-null are stored as different facts.
    expect((db.prepare("SELECT count(*) c FROM request WHERE session_present = 0").get() as { c: number }).c).toBe(1);
    expect(
      (db.prepare("SELECT count(*) c FROM request WHERE session_present = 1 AND session_id IS NULL").get() as { c: number }).c,
    ).toBe(1);
  });

  it("answers every wired route byte-identically from SQLite", async () => {
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  it("is idempotent: a second ingest changes nothing", async () => {
    const before = db.prepare("SELECT id, timestamp, model FROM request ORDER BY id").all();
    const stats = await ingest(db, ctx.logDir);
    expect(stats.inserted).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(db.prepare("SELECT id, timestamp, model FROM request ORDER BY id").all()).toEqual(before);
  });

  it("rebuilds identically from an empty database", async () => {
    const before = db.prepare("SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id").all();
    const tools = db.prepare("SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord").all();

    // The supported total-recovery path: drop everything, re-ingest, get the
    // same view back. Nothing here is authored, so nothing is lost.
    db.exec("DELETE FROM request_rate_limit");
    db.exec("DELETE FROM request_tool");
    db.exec("DELETE FROM request");
    db.exec("DELETE FROM request_skipped");
    db.exec("DELETE FROM ingest_watermark");
    await ingest(db, ctx.logDir);

    expect(db.prepare("SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord").all()).toEqual(tools);
  });

  // A harness that cannot fail proves nothing, so make it fail on purpose.
  it("detects a substrate that disagrees", async () => {
    const victim = db.prepare("SELECT id, model FROM request ORDER BY id LIMIT 1").get() as { id: string; model: string };
    db.prepare("UPDATE request SET model = ? WHERE id = ?").run("wrong-model", victim.id);
    try {
      const found = await mismatches(ctx, db);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join("\n")).toContain("wrong-model");
    } finally {
      db.prepare("UPDATE request SET model = ? WHERE id = ?").run(victim.model, victim.id);
    }
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  it("needs no normalization to agree", () => {
    // Every entry here has to name the mechanism that makes a difference
    // benign. The DB reader reproduces the file reader's filename ordering
    // rather than sorting differently and compensating, so the list is empty —
    // and an unexplainable diff is a bug, not a candidate for this array.
    expect(NORMALIZATIONS.map((n) => `${n.name}: ${n.why}`)).toEqual([]);
  });
});

/**
 * The same replay against this machine's real archive. Skipped where there is
 * no archive to replay — a clean clone, or CI.
 */
describe("route parity over the real logs/archive", () => {
  const logDir = resolveLogDir();
  let days: string[] = [];
  let db: DatabaseSync | null = null;

  beforeAll(async () => {
    days = await archivedDays(logDir);
    if (!days.length) return;
    db = openDb(logDir);
    await ingest(db, logDir);
  }, 300_000);

  afterAll(() => {
    db?.close();
  });

  it("answers every wired route byte-identically for every archived day", async () => {
    if (!days.length || !db) {
      expect(days).toEqual([]);
      return;
    }
    expect(await mismatches({ logDir, limits: resolveUsageLimits({}) }, db)).toEqual([]);
  }, 600_000);
});
