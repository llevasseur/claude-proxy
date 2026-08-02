import { appendFile, copyFile, link, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildSessionSuggestions } from "../src/api.js";
import { commandStorePath, reconcileCommandRuns, resolveCommandsDir } from "../src/command-runs.js";
import { ingest } from "../src/db/ingest.js";
import { openDb } from "../src/db/open.js";
import { dbSource, fileSource } from "../src/db/source.js";
import { resolveLogDir } from "../src/logs.js";
import { resolveSettingsPath } from "../src/settings.js";
import { updateSuggestionStatusStore } from "../src/suggestion-status.js";
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
    // A real last-user-turn, distinct per request: `/api/skim` reads it out of
    // this body, so an empty `messages` would make the skim text uniformly null
    // and the route's parity vacuous.
    await writeFile(
      path.join(dir, `${stem}.request.txt`),
      JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: `ask at ${iso}` }] }] }),
      "utf8",
    );
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
  // A command envelope in the root prompt, so `reconcileCommandRuns` reads this
  // thread as a run of `/task` rather than the store needing a hand-authored record.
  await writeFile(
    path.join(dir, `${parent}.state.json`),
    JSON.stringify({ root: envelope("task", "--sub Move the audit sidecars into SQLite, but keep the files authoritative.") }),
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

  // No header and cut off mid-run. It gets a root prompt naming a command that
  // is *not* installed, so `/api/commands` carries a row the catalogue does not
  // know — history a `/sync` removed.
  await writeFile(
    path.join(dir, "00000000000000c3.md"),
    ["## Task: something older", "- Bash(ls)", "- interrupted: user", "- done: resumed and finished", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(dir, "00000000000000c3.state.json"),
    JSON.stringify({ root: envelope("retired-command", "--here tidy up") }),
    "utf8",
  );
}

/**
 * A commands catalogue holding the one installed command, with a step tree. The
 * corpus also has runs of a command that is *not* here, so `/api/commands`
 * exercises both halves of its union.
 */
async function writeCommandsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "parity-commands-"));
  await writeFile(
    path.join(dir, "task.md"),
    [
      "Take a task to an open PR.",
      "",
      "## Step 1 — Set up the workspace",
      "Create a worktree with `my-command-tools worktree begin`.",
      "",
      "## Step 2 — Implement the task",
      "Verify with `my-command-tools verify`.",
      "",
      "## Step 3 — Clean, then PR",
      "Run `/clean`, then `/pr`.",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

/** A root prompt as the CLI records it for a slash command. */
function envelope(command: string, args: string): string {
  return `<command-name>/${command}</command-name>\n<command-args>${args}</command-args>`;
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

/**
 * A device settings file for `/api/withheld` to read its deny-list from. Written
 * into the corpus and pinned on the context so the replay does not depend on
 * whatever this machine's `~/.claude/settings.json` happens to hold.
 */
async function writeSettings(logDir: string): Promise<string> {
  const file = path.join(logDir, "settings.json");
  await writeFile(
    file,
    JSON.stringify({
      permissions: { deny: ["WebSearch", "Bash(rm:*)"] },
      disableAllHooks: true,
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      enabledPlugins: { "example@marketplace": true },
    }),
    "utf8",
  );
  return file;
}

/**
 * Flag one suggestion, so `/api/sessions/suggestions/status` replays a real join
 * rather than an all-unflagged one. The flags themselves are authored state and
 * never enter the DB — the join's *left* side is what the substrate supplies.
 */
async function flagOneSuggestion(logDir: string): Promise<void> {
  const { buckets } = await buildSessionSuggestions(logDir, fileSource);
  const bucket = buckets[0];
  const suggestion = bucket?.suggestions[0];
  if (!bucket || !suggestion) return;
  await updateSuggestionStatusStore(
    logDir,
    [{ bucket: bucket.index, id: suggestion.id, status: "done", note: "handled" }],
    new Date("2026-07-18T00:00:00.000Z"),
  );
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
    const commandsDir = await writeCommandsDir();
    // The store under test is the one the reconcile pass writes, not a fixture, so
    // the record shapes are whatever the real distiller produces.
    await reconcileCommandRuns(logDir, commandsDir, new Date("2026-07-18T00:00:00.000Z"));
    await flagOneSuggestion(logDir);
    ctx = { logDir, limits: resolveUsageLimits({}), commandsDir, settingsPath: await writeSettings(logDir) };
    db = openDb(logDir);
    await ingest(db, logDir);
  });

  afterAll(async () => {
    db?.close();
    if (ctx?.commandsDir) await rm(ctx.commandsDir, { recursive: true, force: true });
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
    // The subagent has no `state.json` at all, which reads the same as one
    // carrying no `root`: null.
    expect(
      (db.prepare("SELECT count(*) c FROM session WHERE root_prompt IS NOT NULL").get() as { c: number }).c,
    ).toBe(2);
  });

  it("indexes every command run, its tree, and the document it round-trips", () => {
    // Both root prompts read as runs: one of an installed command, one of a
    // command the catalogue no longer has.
    expect((db.prepare("SELECT count(*) c FROM command_run").get() as { c: number }).c).toBe(2);
    expect(
      db.prepare("SELECT command FROM command_run ORDER BY command").all().map((r) => (r as { command: string }).command),
    ).toEqual(["retired-command", "task"]);
    // The envelope's leading flags are indexed as their own rows.
    expect(
      db.prepare("SELECT flag FROM command_run_flag ORDER BY flag").all().map((r) => (r as { flag: string }).flag),
    ).toEqual(["here", "sub"]);
    // The `/task` run's family is the parent plus the subagent it spawned.
    expect(
      (db.prepare("SELECT count(*) c FROM command_run_thread WHERE thread_id = ?").get("00000000000000a1") as {
        c: number;
      }).c,
    ).toBe(2);
    // Every row's document re-parses into the record the file reader hands back.
    const documents = db.prepare("SELECT document FROM command_run ORDER BY ord").all();
    for (const row of documents) {
      expect(() => JSON.parse((row as { document: string }).document)).not.toThrow();
    }
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
    // The store did not move either, so its `file_watermark` row skips it
    // without the file being opened.
    expect(stats.commandRuns).toBe(2);
    expect(stats.commandRunsParsed).toBe(false);
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

  it("re-reads a command store that grew, and drops the rows when it leaves", async () => {
    const store = commandStorePath(ctx.logDir);
    const runs = await fileSource.readCommandRuns(ctx.logDir);
    const victim = runs.find((r) => r.command === "retired-command");
    expect(victim, "the corpus should hold a run to retire").toBeDefined();

    // Retracting a record means appending it again with the tombstone set. The row
    // stays — it is what the file holds — and the live view drops it on both sides.
    await appendFile(store, `${JSON.stringify({ ...victim!, retired: true })}\n`, "utf8");
    let stats = await ingest(db, ctx.logDir);
    expect(stats.commandRunsParsed).toBe(true);
    expect(stats.commandRuns).toBe(2);
    expect((db.prepare("SELECT count(*) c FROM command_run WHERE retired = 1").get() as { c: number }).c).toBe(1);
    expect((await fileSource.readCommandRuns(ctx.logDir)).map((r) => r.command)).toEqual(["task"]);
    expect(await mismatches(ctx, db)).toEqual([]);

    // The store is the rows' only source: losing it takes them, and the
    // children cascade.
    await rm(store);
    stats = await ingest(db, ctx.logDir);
    expect(stats.commandRuns).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM command_run").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT count(*) c FROM command_run_turn").get() as { c: number }).c).toBe(0);
    expect(await mismatches(ctx, db)).toEqual([]);

    // Put it back, so the rebuild below has a store to rebuild from.
    await reconcileCommandRuns(ctx.logDir, ctx.commandsDir!, new Date("2026-07-18T00:00:00.000Z"));
    await ingest(db, ctx.logDir);
    expect((db.prepare("SELECT count(*) c FROM command_run").get() as { c: number }).c).toBe(2);
  });

  it("rebuilds identically from an empty database", async () => {
    const before = db.prepare("SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id").all();
    const tools = db.prepare("SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord").all();
    const sessions = db.prepare("SELECT * FROM session ORDER BY thread_id").all();
    const nodes = db.prepare("SELECT * FROM session_node ORDER BY thread_id, idx").all();
    const texts = db.prepare("SELECT * FROM session_node_text ORDER BY thread_id, idx").all();
    const commandRuns = db.prepare("SELECT * FROM command_run ORDER BY ord").all();
    const commandSteps = db.prepare("SELECT * FROM command_run_step ORDER BY thread_id, ord").all();

    // The total-recovery path: drop everything, re-ingest, get the same view
    // back.
    db.exec("DELETE FROM request_rate_limit");
    db.exec("DELETE FROM request_tool");
    db.exec("DELETE FROM request");
    db.exec("DELETE FROM request_skipped");
    db.exec("DELETE FROM ingest_watermark");
    db.exec("DELETE FROM session");
    db.exec("DELETE FROM command_run");
    db.exec("DELETE FROM file_watermark");
    await ingest(db, ctx.logDir);

    expect(db.prepare("SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord").all()).toEqual(tools);
    expect(db.prepare("SELECT * FROM session ORDER BY thread_id").all()).toEqual(sessions);
    expect(db.prepare("SELECT * FROM session_node ORDER BY thread_id, idx").all()).toEqual(nodes);
    expect(db.prepare("SELECT * FROM session_node_text ORDER BY thread_id, idx").all()).toEqual(texts);
    expect(db.prepare("SELECT * FROM command_run ORDER BY ord").all()).toEqual(commandRuns);
    expect(db.prepare("SELECT * FROM command_run_step ORDER BY thread_id, ord").all()).toEqual(commandSteps);
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

/**
 * The inputs a wired route reads out of the log directory.
 *
 * `.request.txt` joined in slice 4: `/api/skim` parses the captured body for the
 * last user turn, so leaving it out would make both sides read `null` and the
 * route's parity vacuous. It is write-once, so a hardlink freezes it.
 */
const SNAPSHOT_SUFFIXES = [".audit.json", ".request.txt"];

/**
 * What `sessions/` contributes. Separate from {@link SNAPSHOT_SUFFIXES} because
 * `.md` means two things in this tree: a transcript under `sessions/`, and a
 * request's rendered body beside its audit sidecar. Taking the latter would
 * change which requests read as blob-evicted.
 */
const SESSION_SUFFIXES = [".md", ".nodes.jsonl", ".state.json"];

/**
 * Live files a route reads that are not sidecars, and that get rewritten.
 *
 * Both are written temp-file-then-rename, so a hardlink genuinely freezes them:
 * the rename swaps the directory entry and leaves the inode this snapshot holds
 * untouched. `suggestion-status.json` is authored state that never enters the
 * DB — it is the right-hand side of the join `/api/sessions/suggestions/status`
 * replays.
 */
const SNAPSHOT_FILES = ["usage-live.json", "suggestion-status.json"];

/**
 * Hardlink `from`'s snapshot-worthy files into `to`, copying across filesystems.
 *
 * `freeze` copies instead. A hardlink shares the inode, so it freezes which
 * files exist but not their contents — enough for write-once audit sidecars,
 * not for a transcript the proxy is still appending to.
 */
async function linkInto(
  from: string,
  to: string,
  suffixes: string[] = SNAPSHOT_SUFFIXES,
  freeze = false,
): Promise<void> {
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
      if (freeze) await copyFile(src, dest);
      else await link(src, dest);
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
 * Hardlinks the audit sidecars, the `.request.txt` bodies and the rewritten-by-
 * rename files, so the snapshot costs directory entries rather than the corpus.
 * `sessions/` is *copied* instead: transcripts are appended to for the life of a
 * run, and a hardlink would carry those appends straight into the snapshot. The
 * rendered `.md` bodies are still left out — no wired route reads them, and
 * taking them would change which requests read as blob-evicted.
 *
 * `commands/runs.jsonl` is *copied* for the same reason `sessions/` is: the
 * reconcile pass appends to it while a run is in flight, and a hardlink would
 * carry those appends into the snapshot.
 */
async function snapshotLogs(logDir: string, days: string[]): Promise<string> {
  const snap = await mkdtemp(path.join(tmpdir(), "parity-real-"));
  await linkInto(logDir, snap);
  const sessions = path.join(snap, "sessions");
  await mkdir(sessions, { recursive: true });
  await linkInto(path.join(logDir, "sessions"), sessions, SESSION_SUFFIXES, true);
  await mkdir(path.join(snap, "commands"), { recursive: true });
  await copyFile(commandStorePath(logDir), commandStorePath(snap)).catch(() => {
    // No store on this machine yet: an empty commands page, not a failure.
  });
  for (const day of days) {
    const dest = path.join(snap, "archive", day);
    await mkdir(dest, { recursive: true });
    await linkInto(path.join(logDir, "archive", day), dest);
  }
  return snap;
}

/**
 * A frozen copy of the installed command catalogue. It lives outside `logs/`, but
 * a `/sync` landing between the two replays would still move it under them.
 */
async function snapshotCommandsDir(): Promise<string> {
  const snap = await mkdtemp(path.join(tmpdir(), "parity-real-commands-"));
  await linkInto(resolveCommandsDir(), snap, [".md"], true);
  return snap;
}

/**
 * A frozen copy of this machine's device settings, for `/api/withheld`.
 *
 * The shell rc that route also reads has no injection point, so it is read live
 * by both replays. That is a settled non-risk: an rc edit landing in the
 * milliseconds between the two reads would be a genuine difference in the input,
 * and the file is not one anything writes automatically.
 */
async function snapshotSettings(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "parity-real-settings-"));
  const dest = path.join(dir, "settings.json");
  await copyFile(resolveSettingsPath(), dest).catch(() => {
    // No settings on this machine: an unreadable file is a state the route
    // already handles, and both sides see it alike.
  });
  return dest;
}

/**
 * The same replay against this machine's real archive, snapshotted first.
 * Skipped where there is no archive to replay — a clean clone, or CI.
 */
describe("route parity over the real logs/archive", () => {
  let days: string[] = [];
  let snapshot: string | null = null;
  let commandsDir: string | null = null;
  let settingsPath: string | null = null;
  let db: DatabaseSync | null = null;

  beforeAll(async () => {
    const logDir = resolveLogDir();
    days = await archivedDays(logDir);
    if (!days.length) return;
    snapshot = await snapshotLogs(logDir, days);
    commandsDir = await snapshotCommandsDir();
    settingsPath = await snapshotSettings();
    db = openDb(snapshot);
    await ingest(db, snapshot);
  }, 300_000);

  afterAll(async () => {
    db?.close();
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
    if (commandsDir) await rm(commandsDir, { recursive: true, force: true });
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
    expect(
      await mismatches(
        {
          logDir: snapshot,
          limits: resolveUsageLimits({}),
          commandsDir: commandsDir ?? undefined,
          settingsPath: settingsPath ?? undefined,
        },
        db,
      ),
    ).toEqual([]);
  }, 600_000);
});
