import { appendFile, copyFile, link, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
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
 * Every wired route, replayed against the same corpus through the file scan and
 * through SQLite, asserting the full JSON is identical.
 *
 * Two corpora. The synthetic one runs everywhere: a legacy sidecar with no
 * session/skim/rateLimit, a file that will not parse, a structurally invalid
 * one, a request whose bodies have been evicted, and two requests sharing a tool
 * name so the digest's tie-breaking order is exercised. The real one is whatever
 * `logs/archive` holds on this machine.
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
 * The transcripts, plus the `.nodes.jsonl` / `.state.json` sidecars beside them.
 *
 * Three threads under one session id: a parent that spawns a subagent, the
 * subagent itself, and a legacy transcript with no header, no sidecars and an
 * interruption. Between them they cover the agent tree, the header fields, an
 * absent `state.json`, and a node-text entry naming an index the transcript does
 * not have — which the file reader returns rather than dropping.
 */
async function writeSessions(logDir: string): Promise<void> {
  const dir = path.join(logDir, "sessions");
  await mkdir(dir, { recursive: true });

  const parent = "00000000000000a1";
  await writeFile(
    path.join(dir, `${parent}.md`),
    [
      "- model: claude-opus-5",
      "- session: s-1",
      "- started: 2026-07-15T14:00:00.000Z",
      "- title: Index the logs",
      "- subtitle: Move the audit sidecars into SQLite",
      "",
      "## Task: Index the logs",
      "- decided: keep logs/ the source of truth",
      "- Bash(pnpm test)",
      "- ✗ typecheck failed",
      "- Agent(subagent_type=Explore, description=find the readers)",
      "- Read(server/src/api.ts)",
      "- done: indexed",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(dir, `${parent}.state.json`),
    JSON.stringify({ root: "Move the audit sidecars into SQLite, but keep the files authoritative." }),
    "utf8",
  );
  await writeFile(
    path.join(dir, `${parent}.nodes.jsonl`),
    [
      JSON.stringify({ i: 1, text: "keep logs/ the source of truth, because a view may not hold the only copy" }),
      "{ torn line",
      // Index 99 is past the end of the transcript: the sidecar is sparse and
      // outlives edits, and both readers hand the entry back regardless.
      JSON.stringify({ i: 99, text: "an index this transcript no longer has" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const child = "00000000000000b2";
  await writeFile(
    path.join(dir, `${child}.md`),
    [
      "- model: claude-opus-5",
      "- session: s-1",
      "- started: 2026-07-15T14:05:00.000Z",
      "",
      "## Task: find the readers",
      "- Grep(readSidecars)",
      "- done: found four",
      "",
    ].join("\n"),
    "utf8",
  );

  // No header, no sidecars, and cut off mid-run.
  await writeFile(
    path.join(dir, "00000000000000c3.md"),
    ["## Task: something older", "- Bash(ls)", "- interrupted: user", "- done: resumed and finished", ""].join("\n"),
    "utf8",
  );
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
  // Same tool name as the request above, different byte weight: the digest
  // accumulates them into one row, and ties break by first appearance.
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
  // 01:30Z on the 16th is filed under the next UTC folder while belonging to
  // the 15th's reporting day.
  await writeTriple(dayTwo, "2026-07-16T01:30:00.000Z");
  await writeTriple(dayTwo, "2026-07-16T14:00:00.000Z", { model: "claude-haiku-4-5-20251001" });

  // A session all-null but present, which is a different fact from absent.
  await writeTriple(logDir, "2026-07-17T14:00:00.000Z", {
    session: { sessionId: null, app: null, userAgent: null, account: null, metadataSessionId: null, deviceId: null },
  });

  await writeSessions(logDir);
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

  it("indexes every transcript, its nodes, and its sparse node texts", () => {
    expect((db.prepare("SELECT count(*) c FROM session").get() as { c: number }).c).toBe(3);
    // Seven appended lines under the parent; the interruption on the legacy
    // transcript is a flag on a node, not a node of its own.
    expect(
      (db.prepare("SELECT count(*) c FROM session_node WHERE thread_id = ?").get("00000000000000a1") as { c: number }).c,
    ).toBe(7);
    expect((db.prepare("SELECT count(*) c FROM session_node WHERE interrupted = 1").get() as { c: number }).c).toBe(1);
    // The torn line is dropped, the out-of-range index is kept.
    expect(
      (db.prepare("SELECT count(*) c FROM session_node_text").get() as { c: number }).c,
    ).toBe(2);
    // An absent `state.json` and one carrying no `root` read the same: null.
    expect(
      (db.prepare("SELECT count(*) c FROM session WHERE root_prompt IS NOT NULL").get() as { c: number }).c,
    ).toBe(1);
  });

  it("answers every wired route byte-identically from SQLite", async () => {
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  it("is idempotent: a second ingest changes nothing", async () => {
    const before = db.prepare("SELECT id, timestamp, model FROM request ORDER BY id").all();
    const sessions = db.prepare("SELECT thread_id, bytes, modified, root_prompt FROM session ORDER BY thread_id").all();
    const nodes = db.prepare("SELECT thread_id, idx, type, text FROM session_node ORDER BY thread_id, idx").all();
    const stats = await ingest(db, ctx.logDir);
    expect(stats.inserted).toBe(0);
    expect(stats.deleted).toBe(0);
    // Nothing was appended between the passes, so the per-file watermark skips
    // every transcript rather than re-reading it.
    expect(stats.sessions).toBe(3);
    expect(stats.sessionsParsed).toBe(0);
    expect(db.prepare("SELECT id, timestamp, model FROM request ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT thread_id, bytes, modified, root_prompt FROM session ORDER BY thread_id").all()).toEqual(
      sessions,
    );
    expect(db.prepare("SELECT thread_id, idx, type, text FROM session_node ORDER BY thread_id, idx").all()).toEqual(nodes);
  });

  it("re-reads a transcript that grew, and drops one that left", async () => {
    const dir = path.join(ctx.logDir, "sessions");
    const extra = path.join(dir, "00000000000000d4.md");
    await writeFile(extra, ["- session: s-1", "- started: 2026-07-15T18:00:00.000Z", "## Task: transient", ""].join("\n"), "utf8");
    let stats = await ingest(db, ctx.logDir);
    expect(stats.sessions).toBe(4);
    expect(stats.sessionsParsed).toBe(1);

    // An append moves the size, which is what the watermark keys on.
    await appendFile(extra, "- done: appended\n", "utf8");
    stats = await ingest(db, ctx.logDir);
    expect(stats.sessionsParsed).toBe(1);
    expect(
      (db.prepare("SELECT count(*) c FROM session_node WHERE thread_id = ?").get("00000000000000d4") as { c: number }).c,
    ).toBe(2);
    expect(await mismatches(ctx, db)).toEqual([]);

    // The transcript is the row's source: losing it takes the row and, by
    // cascade, its nodes.
    await rm(extra);
    stats = await ingest(db, ctx.logDir);
    expect(stats.sessions).toBe(3);
    expect((db.prepare("SELECT count(*) c FROM session").get() as { c: number }).c).toBe(3);
    expect(
      (db.prepare("SELECT count(*) c FROM session_node WHERE thread_id = ?").get("00000000000000d4") as { c: number }).c,
    ).toBe(0);
  });

  it("rebuilds identically from an empty database", async () => {
    const before = db.prepare("SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id").all();
    const tools = db.prepare("SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord").all();
    const sessions = db.prepare("SELECT * FROM session ORDER BY thread_id").all();
    const nodes = db.prepare("SELECT * FROM session_node ORDER BY thread_id, idx").all();
    const texts = db.prepare("SELECT * FROM session_node_text ORDER BY thread_id, idx").all();

    // The total-recovery path: drop everything, re-ingest, get the same view
    // back.
    db.exec("DELETE FROM request_rate_limit");
    db.exec("DELETE FROM request_tool");
    db.exec("DELETE FROM request");
    db.exec("DELETE FROM request_skipped");
    db.exec("DELETE FROM ingest_watermark");
    db.exec("DELETE FROM session");
    await ingest(db, ctx.logDir);

    expect(db.prepare("SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord").all()).toEqual(tools);
    expect(db.prepare("SELECT * FROM session ORDER BY thread_id").all()).toEqual(sessions);
    expect(db.prepare("SELECT * FROM session_node ORDER BY thread_id, idx").all()).toEqual(nodes);
    expect(db.prepare("SELECT * FROM session_node_text ORDER BY thread_id, idx").all()).toEqual(texts);
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
    // Every entry has to name the mechanism that makes a difference benign. The
    // DB reader reproduces the file reader's filename ordering rather than
    // compensating for a different one, so the list is empty.
    expect(NORMALIZATIONS.map((n) => `${n.name}: ${n.why}`)).toEqual([]);
  });
});

/** The inputs a wired route reads out of the log directory. */
const SNAPSHOT_SUFFIXES = [".audit.json"];

/**
 * What `sessions/` contributes. Kept separate from {@link SNAPSHOT_SUFFIXES}
 * because `.md` means two different things in this tree: a transcript under
 * `sessions/`, and a request's rendered body beside its audit sidecar. Taking
 * the latter would change which requests read as blob-evicted.
 */
const SESSION_SUFFIXES = [".md", ".nodes.jsonl", ".state.json"];

/** Live files a route reads that are not sidecars, and that the proxy rewrites. */
const SNAPSHOT_FILES = ["usage-live.json"];

/** Hardlink `from`'s snapshot-worthy files into `to`, copying across filesystems. */
async function linkInto(from: string, to: string, suffixes: string[] = SNAPSHOT_SUFFIXES): Promise<void> {
  let names: string[];
  try {
    names = await readdir(from);
  } catch {
    return;
  }
  for (const name of names) {
    if (!suffixes.some((s) => name.endsWith(s)) && !SNAPSHOT_FILES.includes(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    try {
      await link(src, dest);
    } catch {
      try {
        await copyFile(src, dest);
      } catch {
        // Vanished between the listing and the link, so it is not part of
        // this snapshot.
      }
    }
  }
}

/**
 * A frozen copy of the real log directory.
 *
 * The proxy writes to the live directory continuously, so replaying against it
 * directly is a race: {@link runCase} reads the file side first, and a sidecar
 * landing before the DB side reads shows up as a one-request mismatch that has
 * nothing to do with the substrate.
 *
 * Hardlinks, so the snapshot costs directory entries rather than the corpus. It
 * carries the audit sidecars, `usage-live.json`, and the whole `sessions/`
 * directory — the transcripts are appended to for the life of a run, so they are
 * exactly the race this exists to close. The `.md` / `.request.txt` request
 * bodies are still left out: no wired route reads them. A later slice that wires
 * a blob-reading route has to widen {@link SNAPSHOT_SUFFIXES}.
 */
async function snapshotLogs(logDir: string, days: string[]): Promise<string> {
  const snap = await mkdtemp(path.join(tmpdir(), "parity-real-"));
  await linkInto(logDir, snap);
  const sessions = path.join(snap, "sessions");
  await mkdir(sessions, { recursive: true });
  await linkInto(path.join(logDir, "sessions"), sessions, SESSION_SUFFIXES);
  for (const day of days) {
    const dest = path.join(snap, "archive", day);
    await mkdir(dest, { recursive: true });
    await linkInto(path.join(logDir, "archive", day), dest);
  }
  return snap;
}

/**
 * The same replay against this machine's real archive, snapshotted first.
 * Skipped where there is no archive to replay — a clean clone, or CI.
 */
describe("route parity over the real logs/archive", () => {
  let days: string[] = [];
  let snapshot: string | null = null;
  let db: DatabaseSync | null = null;

  beforeAll(async () => {
    const logDir = resolveLogDir();
    days = await archivedDays(logDir);
    if (!days.length) return;
    snapshot = await snapshotLogs(logDir, days);
    db = openDb(snapshot);
    await ingest(db, snapshot);
  }, 300_000);

  afterAll(async () => {
    db?.close();
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
  });

  it("snapshots the archive it is about to replay", async () => {
    if (!days.length || !snapshot) return;
    expect(await archivedDays(snapshot)).toEqual(days);
    expect((await stat(path.join(snapshot, "archive", days[0]!))).isDirectory()).toBe(true);
  });

  it("answers every wired route byte-identically for every archived day", async () => {
    if (!days.length || !db || !snapshot) {
      expect(days).toEqual([]);
      return;
    }
    expect(await mismatches({ logDir: snapshot, limits: resolveUsageLimits({}) }, db)).toEqual([]);
  }, 600_000);
});
