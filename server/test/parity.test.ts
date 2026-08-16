import { appendFile, copyFile, link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runKey } from '@claude-proxy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySuggestionStatus, buildSessionSuggestions } from '../src/api.js';
import { commandStorePath, reconcileCommandRuns, resolveCommandsDir } from '../src/command-runs.js';
import { conceptStorePath } from '../src/concepts.js';
import { ingest } from '../src/db/ingest.js';
import { applyCommandRunAppend } from '../src/db/ingest-commands.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource } from '../src/db/source.js';
import { resolveLogDir } from '../src/logs.js';
import {
  archivedDays,
  archivedDaysSync,
  NORMALIZATIONS,
  PARITY_ROUTES,
  type ParityContext,
  type ParityRoute,
  resetCaches,
  runCase,
} from '../src/parity.js';
import { resolveSettingsPath } from '../src/settings.js';
import { updateSuggestionStatusStore } from '../src/suggestion-status.js';
import { resolveUsageLimits } from '../src/usage-config.js';

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
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

interface SidecarOpts {
  model?: string;
  tools?: Array<{ name: string; bytes: number; estTokens: number }>;
  session?: Record<string, string | null> | null;
  skim?: Record<string, unknown> | null;
  rateLimit?: Record<string, string> | null;
  realInput?: number;
  system?: { hash: string; blocks: number; sections: number };
}

function sidecarBody(iso: string, opts: SidecarOpts = {}): Record<string, unknown> {
  const tools = opts.tools ?? [{ name: 'Bash', bytes: 900, estTokens: 225 }];
  const body: Record<string, unknown> = {
    timestamp: iso,
    model: opts.model ?? 'claude-opus-5',
    endpoint: '/v1/messages',
    statusCode: 200,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 400,
      cacheCreation: 25,
      realInput: opts.realInput ?? 525,
    },
    request: {
      toolCount: tools.length,
      toolsBytes: 900,
      systemBytes: 1200,
      totalBytes: 4000,
      ...(opts.system ? { system: opts.system } : {}),
    },
    tools,
  };
  if (opts.session !== null) {
    body.session = opts.session ?? {
      sessionId: 's-1',
      app: 'claude-code',
      userAgent: 'claude-cli/2.0',
      account: 'someone@example.com',
      metadataSessionId: 'm-1',
      deviceId: 'd-1',
      // The thread the proxy resolved at capture time. Present here and absent on
      // the all-null session below, so both branches of the rebuild are covered.
      threadId: '00000000000000a1',
    };
  }
  if (opts.skim !== null) {
    body.skim = opts.skim ?? { enabled: true, servedFromCache: false, savedInputTokens: 0, cacheKey: null };
  }
  if (opts.rateLimit !== null) {
    body.rateLimit = opts.rateLimit ?? {
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-remaining': '40000',
    };
  }
  return body;
}

/** Write the audit sidecar plus the `.md` / `.request.txt` blobs beside it. */
async function writeTriple(dir: string, iso: string, opts: SidecarOpts & { blobs?: boolean } = {}): Promise<void> {
  const stem = stemFor(iso);
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(sidecarBody(iso, opts)), 'utf8');
  if (opts.blobs !== false) {
    await writeFile(path.join(dir, `${stem}.md`), `# ${iso}\n`, 'utf8');
    // A distinct last-user-turn per request: `/api/skim` reads its text out of
    // this body, and empty `messages` would make that route's parity vacuous.
    await writeFile(
      path.join(dir, `${stem}.request.txt`),
      JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: `ask at ${iso}` }] }] }),
      'utf8',
    );
  }
}

async function writeRaw(dir: string, iso: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), contents, 'utf8');
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
  const dir = path.join(logDir, 'sessions');
  await mkdir(dir, { recursive: true });

  const parent = '00000000000000a1';
  await writeFile(
    path.join(dir, `${parent}.md`),
    [
      '- model: claude-opus-5',
      '- session: s-1',
      '- started: 2026-07-15T14:00:00.000Z',
      '- title: Index the logs',
      '- subtitle: Move the audit sidecars into SQLite',
      '',
      '## Task: Index the logs',
      '- decided: keep logs/ the source of truth',
      '- Bash(pnpm test)',
      '- ✗ typecheck failed',
      '- Agent(subagent_type=Explore, description=find the readers)',
      '- Read(server/src/api.ts)',
      '- done: indexed',
      '',
    ].join('\n'),
    'utf8',
  );
  // A command envelope in the root prompt, so `reconcileCommandRuns` reads this
  // thread as a run of `/task` rather than the store needing a hand-authored record.
  await writeFile(
    path.join(dir, `${parent}.state.json`),
    JSON.stringify({
      root: envelope('task', '--sub Move the audit sidecars into SQLite, but keep the files authoritative.'),
    }),
    'utf8',
  );
  await writeFile(
    path.join(dir, `${parent}.nodes.jsonl`),
    [
      JSON.stringify({ i: 1, text: 'keep logs/ the source of truth, because a view may not hold the only copy' }),
      // A row carrying only a fingerprint, and one carrying both — the sidecar's two
      // sparse maps are independent.
      JSON.stringify({ i: 2, argsHash: 'aaaabbbbccccdddd' }),
      JSON.stringify({ i: 5, text: 'Read(server/src/api.ts)', argsHash: '1111222233334444' }),
      '{ torn line',
      // Index 99 is past the end of the transcript: the sidecar is sparse and
      // outlives edits, and both readers hand the entry back regardless.
      JSON.stringify({ i: 99, text: 'an index this transcript no longer has' }),
      '',
    ].join('\n'),
    'utf8',
  );

  const child = '00000000000000b2';
  await writeFile(
    path.join(dir, `${child}.md`),
    [
      '- model: claude-opus-5',
      '- session: s-1',
      '- started: 2026-07-15T14:05:00.000Z',
      // The parentage the proxy wrote down when it saw the spawn go out.
      '- parent: 00000000000000a1',
      '- spawn: 4',
      '- agent: Explore',
      '',
      '## Task: find the readers',
      '- Grep(readSidecars)',
      '- done: found four',
      '',
    ].join('\n'),
    'utf8',
  );

  // No header and cut off mid-run. It gets a root prompt naming a command that
  // is *not* installed, so `/api/commands` carries a row the catalogue does not
  // know — history a `/sync` removed.
  await writeFile(
    path.join(dir, '00000000000000c3.md'),
    ['## Task: something older', '- Bash(ls)', '- interrupted: user', '- done: resumed and finished', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(dir, '00000000000000c3.state.json'),
    JSON.stringify({ root: envelope('retired-command', '--here tidy up') }),
    'utf8',
  );
}

/**
 * A commands catalogue holding the one installed command, with a step tree. The
 * corpus also has runs of a command that is *not* here, so `/api/commands`
 * exercises both halves of its union.
 */
async function writeCommandsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parity-commands-'));
  await writeFile(
    path.join(dir, 'task.md'),
    [
      'Take a task to an open PR.',
      '',
      '## Step 1 — Set up the workspace',
      'Create a worktree with `my-command-tools worktree begin`.',
      '',
      '## Step 2 — Implement the task',
      'Verify with `my-command-tools verify`.',
      '',
      '## Step 3 — Clean, then PR',
      'Run `/clean`, then `/pr`.',
      '',
    ].join('\n'),
    'utf8',
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
  const logDir = await mkdtemp(path.join(tmpdir(), 'parity-'));
  const dayOne = path.join(logDir, 'archive', '2026-07-15');
  const dayTwo = path.join(logDir, 'archive', '2026-07-16');
  await mkdir(dayOne, { recursive: true });
  await mkdir(dayTwo, { recursive: true });

  await writeTriple(dayOne, '2026-07-15T14:00:00.000Z');
  // Same tool name as the request above, different byte weight: the digest
  // accumulates them into one row, and ties break by first appearance.
  await writeTriple(dayOne, '2026-07-15T15:00:00.000Z', {
    tools: [
      { name: 'Bash', bytes: 900, estTokens: 225 },
      { name: 'Read', bytes: 900, estTokens: 300 },
    ],
    model: 'claude-sonnet-5',
  });
  // A legacy sidecar: no session, no skim, no rate-limit headers, and — like
  // every sidecar above — no system-prompt identity either.
  await writeTriple(dayOne, '2026-07-15T16:00:00.000Z', { session: null, skim: null, rateLimit: null });
  // Carries the identity the proxy now captures, so both backings have to place
  // a present hash and an absent one apart.
  await writeTriple(dayOne, '2026-07-15T16:30:00.000Z', {
    system: { hash: '0123456789abcdef', blocks: 3, sections: 12 },
  });
  // Retention took the bodies but the metrics survive.
  await writeTriple(dayOne, '2026-07-15T17:00:00.000Z', { blobs: false });
  // Not JSON at all.
  await writeRaw(dayOne, '2026-07-15T18:00:00.000Z', '{ this is not json');
  // JSON, but not an audit sidecar — the digest counts it under `skipped`.
  await writeRaw(
    dayOne,
    '2026-07-15T19:00:00.000Z',
    JSON.stringify({ timestamp: '2026-07-15T19:00:00.000Z', nope: 1 }),
  );
  // 01:30Z on the 16th is filed under the next UTC folder while belonging to
  // the 15th's reporting day.
  await writeTriple(dayTwo, '2026-07-16T01:30:00.000Z');
  await writeTriple(dayTwo, '2026-07-16T14:00:00.000Z', { model: 'claude-haiku-4-5-20251001' });

  // A session all-null but present, which is a different fact from absent.
  await writeTriple(logDir, '2026-07-17T14:00:00.000Z', {
    session: { sessionId: null, app: null, userAgent: null, account: null, metadataSessionId: null, deviceId: null },
  });

  await writeSessions(logDir);
  await writeConcepts(logDir);
  return logDir;
}

/**
 * A concept store for `/api/concepts` to replay over, with the same term saved
 * twice — the case the table keeps both rows for.
 */
async function writeConcepts(logDir: string): Promise<void> {
  const records = [
    {
      term: 'carousel',
      sentence: 'A carousel shows one image at a time.',
      field: 'UI component vocabulary',
      skills: ['animation-vocabulary'],
      savedAt: '2026-07-15T18:30:00.000Z',
    },
    {
      term: 'watermark',
      sentence: 'A watermark records how far a store was read.',
      field: 'Ingestion',
      skills: [],
      savedAt: '2026-07-16T09:00:00.000Z',
    },
    {
      term: 'carousel',
      sentence: 'A carousel shows one image at a time.',
      field: 'UI component vocabulary',
      skills: ['animation-vocabulary', 'find-skills'],
      savedAt: '2026-07-17T09:00:00.000Z',
    },
  ];
  await writeFile(conceptStorePath(logDir), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

/**
 * A device settings file for `/api/withheld` to read its deny-list from. Pinned
 * on the context so the replay does not depend on this machine's own settings.
 */
async function writeSettings(logDir: string): Promise<string> {
  const file = path.join(logDir, 'settings.json');
  await writeFile(
    file,
    JSON.stringify({
      permissions: { deny: ['WebSearch', 'Bash(rm:*)'] },
      disableAllHooks: true,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      enabledPlugins: { 'example@marketplace': true },
    }),
    'utf8',
  );
  return file;
}

/**
 * Flag one suggestion, so `/api/sessions/suggestions/status` replays a real join
 * rather than an all-unflagged one. The flags never enter the DB; the join's
 * *left* side is what the substrate supplies.
 */
async function flagOneSuggestion(logDir: string): Promise<void> {
  const { buckets } = await buildSessionSuggestions(logDir, fileSource);
  const bucket = buckets[0];
  expect(bucket, 'the corpus should hold a suggestion bucket to flag').toBeDefined();
  const suggestion = bucket?.suggestions[0];
  expect(suggestion, 'the corpus should hold a suggestion to flag').toBeDefined();
  if (!bucket || !suggestion) return;
  await updateSuggestionStatusStore(
    logDir,
    [{ bucket: bucket.index, id: suggestion.id, status: 'done', note: 'handled' }],
    new Date('2026-07-18T00:00:00.000Z'),
  );
}

/**
 * Replay the given routes' every case both ways, and return the ones that
 * differed alongside how many cases that was. The caches are the caller's to
 * manage: a corpus that mutates between replays wants them dropped each time, a
 * frozen one replayed in several passes wants them kept.
 *
 * The count comes back rather than being asserted here, because a single route
 * legitimately has no cases — `/api/concepts` enumerates nothing when the hosted
 * store is configured.
 */
async function replay(
  ctx: ParityContext,
  db: DatabaseSync,
  routes: ParityRoute[],
): Promise<{ diffs: string[]; cases: number }> {
  const fromDb = dbSource(db);
  const out: string[] = [];
  let cases = 0;
  for (const route of routes) {
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
  return { diffs: out, cases };
}

/** Every registered route, from a cold cache — the whole-corpus replay. */
async function mismatches(ctx: ParityContext, db: DatabaseSync): Promise<string[]> {
  resetCaches();
  const { diffs, cases } = await replay(ctx, db, PARITY_ROUTES);
  expect(cases, 'the harness replayed nothing, so it proved nothing').toBeGreaterThan(0);
  return diffs;
}

describe('route parity over a synthetic corpus', () => {
  let ctx: ParityContext;
  let db: DatabaseSync;

  beforeAll(async () => {
    const logDir = await buildCorpus();
    const commandsDir = await writeCommandsDir();
    // The store under test is the one the reconcile pass writes, not a fixture, so
    // the record shapes are whatever the real distiller produces.
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-18T00:00:00.000Z'));
    await flagOneSuggestion(logDir);
    ctx = { logDir, limits: resolveUsageLimits({}), commandsDir, settingsPath: await writeSettings(logDir) };
    db = openDb(logDir);
    await ingest(db, logDir);
  });

  afterAll(async () => {
    db?.close();
    if (ctx?.commandsDir) await rm(ctx.commandsDir, { recursive: true, force: true });
  });

  it('ingests every sidecar, and files that are not sidecars separately', () => {
    expect((db.prepare('SELECT count(*) c FROM request').get() as { c: number }).c).toBe(8);
    expect((db.prepare('SELECT count(*) c FROM request_skipped').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT count(*) c FROM request WHERE blob_evicted = 1').get() as { c: number }).c).toBe(1);
    // Every body still on disk was derived at ingest time; the evicted one stays
    // underived rather than recording a null as though it had been read.
    expect((db.prepare('SELECT count(*) c FROM request WHERE body_derived = 1').get() as { c: number }).c).toBe(7);
    expect(
      (db.prepare('SELECT count(*) c FROM request WHERE body_derived = 0 AND blob_evicted = 1').get() as { c: number })
        .c,
    ).toBe(1);
    // Absent and all-null are stored as different facts.
    expect((db.prepare('SELECT count(*) c FROM request WHERE session_present = 0').get() as { c: number }).c).toBe(1);
    expect(
      (
        db.prepare('SELECT count(*) c FROM request WHERE session_present = 1 AND session_id IS NULL').get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    // System-prompt identity is stored where the sidecar had one, and left null
    // where it did not.
    expect(
      db
        .prepare(
          'SELECT req_system_hash h, req_system_blocks b, req_system_sections s FROM request WHERE req_system_hash IS NOT NULL',
        )
        .all(),
    ).toEqual([{ h: '0123456789abcdef', b: 3, s: 12 }]);
  });

  it('indexes every transcript, its nodes, and its sparse node texts', () => {
    expect((db.prepare('SELECT count(*) c FROM session').get() as { c: number }).c).toBe(3);
    // Seven appended lines under the parent; the interruption on the legacy
    // transcript is a flag on a node, not a node of its own.
    expect(
      (db.prepare('SELECT count(*) c FROM session_node WHERE thread_id = ?').get('00000000000000a1') as { c: number })
        .c,
    ).toBe(7);
    expect((db.prepare('SELECT count(*) c FROM session_node WHERE interrupted = 1').get() as { c: number }).c).toBe(1);
    // The torn line is dropped, the out-of-range index is kept, and a row
    // carrying both a text and a fingerprint counts once here and once there.
    expect((db.prepare('SELECT count(*) c FROM session_node_text').get() as { c: number }).c).toBe(3);
    // The subagent has no `state.json` at all, which reads the same as one
    // carrying no `root`: null.
    expect((db.prepare('SELECT count(*) c FROM session WHERE root_prompt IS NOT NULL').get() as { c: number }).c).toBe(
      2,
    );
  });

  it('indexes every command run, its tree, and the document it round-trips', () => {
    // Both root prompts read as runs: one of an installed command, one of a
    // command the catalogue no longer has.
    expect((db.prepare('SELECT count(*) c FROM command_run').get() as { c: number }).c).toBe(2);
    expect(
      db
        .prepare('SELECT command FROM command_run ORDER BY command')
        .all()
        .map((r) => (r as { command: string }).command),
    ).toEqual(['retired-command', 'task']);
    // The envelope's leading flags are indexed as their own rows.
    expect(
      db
        .prepare('SELECT flag FROM command_run_flag ORDER BY flag')
        .all()
        .map((r) => (r as { flag: string }).flag),
    ).toEqual(['here', 'sub']);
    // The `/task` run's family is the parent plus the subagent it spawned.
    expect(
      (
        db.prepare('SELECT count(*) c FROM command_run_thread WHERE run_id = ?').get('00000000000000a1') as {
          c: number;
        }
      ).c,
    ).toBe(2);
    // Every row's document re-parses into the record the file reader hands back.
    const documents = db.prepare('SELECT document FROM command_run ORDER BY ord').all();
    for (const row of documents) {
      expect(() => JSON.parse((row as { document: string }).document)).not.toThrow();
    }
  });

  it('answers every wired route byte-identically from SQLite', async () => {
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  it('is idempotent: a second ingest changes nothing', async () => {
    const before = db.prepare('SELECT id, timestamp, model FROM request ORDER BY id').all();
    const sessions = db.prepare('SELECT thread_id, bytes, modified, root_prompt FROM session ORDER BY thread_id').all();
    const nodes = db.prepare('SELECT thread_id, idx, type, text FROM session_node ORDER BY thread_id, idx').all();
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
    expect(db.prepare('SELECT id, timestamp, model FROM request ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT thread_id, bytes, modified, root_prompt FROM session ORDER BY thread_id').all()).toEqual(
      sessions,
    );
    expect(db.prepare('SELECT thread_id, idx, type, text FROM session_node ORDER BY thread_id, idx').all()).toEqual(
      nodes,
    );
  });

  it('re-reads a transcript that grew, and drops one that left', async () => {
    const dir = path.join(ctx.logDir, 'sessions');
    const extra = path.join(dir, '00000000000000d4.md');
    await writeFile(
      extra,
      ['- session: s-1', '- started: 2026-07-15T18:00:00.000Z', '## Task: transient', ''].join('\n'),
      'utf8',
    );
    let stats = await ingest(db, ctx.logDir);
    expect(stats.sessions).toBe(4);
    expect(stats.sessionsParsed).toBe(1);

    // An append moves the size, which is what the watermark keys on.
    await appendFile(extra, '- done: appended\n', 'utf8');
    stats = await ingest(db, ctx.logDir);
    expect(stats.sessionsParsed).toBe(1);
    expect(
      (db.prepare('SELECT count(*) c FROM session_node WHERE thread_id = ?').get('00000000000000d4') as { c: number })
        .c,
    ).toBe(2);
    expect(await mismatches(ctx, db)).toEqual([]);

    // The transcript is the row's source: losing it takes the row and, by
    // cascade, its nodes.
    await rm(extra);
    stats = await ingest(db, ctx.logDir);
    expect(stats.sessions).toBe(3);
    expect((db.prepare('SELECT count(*) c FROM session').get() as { c: number }).c).toBe(3);
    expect(
      (db.prepare('SELECT count(*) c FROM session_node WHERE thread_id = ?').get('00000000000000d4') as { c: number })
        .c,
    ).toBe(0);
  });

  it('re-reads a command store that grew, and drops the rows when it leaves', async () => {
    const store = commandStorePath(ctx.logDir);
    const runs = await fileSource.readCommandRuns(ctx.logDir);
    const victim = runs.find((r) => r.command === 'retired-command');
    expect(victim, 'the corpus should hold a run to retire').toBeDefined();

    // Retracting a record means appending it again with the tombstone set. The row
    // stays — it is what the file holds — and the live view drops it on both sides.
    await appendFile(store, `${JSON.stringify({ ...victim!, retired: true })}\n`, 'utf8');
    let stats = await ingest(db, ctx.logDir);
    expect(stats.commandRunsParsed).toBe(true);
    expect(stats.commandRuns).toBe(2);
    expect((db.prepare('SELECT count(*) c FROM command_run WHERE retired = 1').get() as { c: number }).c).toBe(1);
    expect((await fileSource.readCommandRuns(ctx.logDir)).map((r) => r.command)).toEqual(['task']);
    expect(await mismatches(ctx, db)).toEqual([]);

    // The store is the rows' only source: losing it takes them, and the
    // children cascade.
    await rm(store);
    stats = await ingest(db, ctx.logDir);
    expect(stats.commandRuns).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM command_run').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM command_run_turn').get() as { c: number }).c).toBe(0);
    expect(await mismatches(ctx, db)).toEqual([]);

    // Put it back, so the rebuild below has a store to rebuild from.
    await reconcileCommandRuns(ctx.logDir, ctx.commandsDir!, new Date('2026-07-18T00:00:00.000Z'));
    await ingest(db, ctx.logDir);
    expect((db.prepare('SELECT count(*) c FROM command_run').get() as { c: number }).c).toBe(2);
  });

  it('rebuilds identically from an empty database', async () => {
    const before = db.prepare('SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id').all();
    const tools = db.prepare('SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord').all();
    const sessions = db.prepare('SELECT * FROM session ORDER BY thread_id').all();
    const nodes = db.prepare('SELECT * FROM session_node ORDER BY thread_id, idx').all();
    const texts = db.prepare('SELECT * FROM session_node_text ORDER BY thread_id, idx').all();
    const commandRuns = db.prepare('SELECT * FROM command_run ORDER BY ord').all();
    const commandSteps = db.prepare('SELECT * FROM command_run_step ORDER BY run_id, ord').all();

    // The total-recovery path: drop everything, re-ingest, get the same view
    // back.
    db.exec('DELETE FROM request_rate_limit');
    db.exec('DELETE FROM request_tool');
    db.exec('DELETE FROM request');
    db.exec('DELETE FROM request_skipped');
    db.exec('DELETE FROM ingest_watermark');
    db.exec('DELETE FROM session');
    db.exec('DELETE FROM command_run');
    db.exec('DELETE FROM file_watermark');
    await ingest(db, ctx.logDir);

    expect(db.prepare('SELECT id, timestamp, model, tokens_real_input FROM request ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT request_id, ord, name, bytes FROM request_tool ORDER BY request_id, ord').all()).toEqual(
      tools,
    );
    expect(db.prepare('SELECT * FROM session ORDER BY thread_id').all()).toEqual(sessions);
    expect(db.prepare('SELECT * FROM session_node ORDER BY thread_id, idx').all()).toEqual(nodes);
    expect(db.prepare('SELECT * FROM session_node_text ORDER BY thread_id, idx').all()).toEqual(texts);
    expect(db.prepare('SELECT * FROM command_run ORDER BY ord').all()).toEqual(commandRuns);
    expect(db.prepare('SELECT * FROM command_run_step ORDER BY run_id, ord').all()).toEqual(commandSteps);
  });

  // A harness that cannot fail proves nothing, so make it fail on purpose.
  it('detects a substrate that disagrees', async () => {
    const victim = db.prepare('SELECT id, model FROM request ORDER BY id LIMIT 1').get() as {
      id: string;
      model: string;
    };
    db.prepare('UPDATE request SET model = ? WHERE id = ?').run('wrong-model', victim.id);
    try {
      const found = await mismatches(ctx, db);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join('\n')).toContain('wrong-model');
    } finally {
      db.prepare('UPDATE request SET model = ? WHERE id = ?').run(victim.model, victim.id);
    }
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  // The harness cannot reach this by construction: it freezes the corpus so
  // nothing is appended mid-replay, which is the only way a row falls behind.
  it('re-reads a transcript the row is behind, rather than pairing stale metadata with fresh content', async () => {
    const id = '00000000000000a1';
    const file = path.join(ctx.logDir, 'sessions', `${id}.md`);
    const fresh = await dbSource(db).readSession(ctx.logDir, id);
    expect(fresh.bytes).toBe(Buffer.byteLength(fresh.content));

    // An append since the last ingest leaves the row's `bytes` counting a
    // shorter transcript than `content` holds.
    const stale = db.prepare('SELECT tasks, bytes FROM session WHERE thread_id = ?').get(id) as {
      tasks: number;
      bytes: number;
    };
    await appendFile(file, '## Task: appended after ingest\n', 'utf8');
    const fromDb = await dbSource(db).readSession(ctx.logDir, id);
    const fromFiles = await fileSource.readSession(ctx.logDir, id);
    expect(fromDb).toEqual(fromFiles);
    expect(fromDb.bytes).toBe(Buffer.byteLength(fromDb.content));
    expect(fromDb.content).toContain('appended after ingest');
    // The row is genuinely behind: this is what would have been served beside
    // the longer content.
    expect(stale.bytes).toBeLessThan(fromDb.bytes);
    expect(fromDb.meta.tasks).toBe(stale.tasks + 1);

    // A transcript with no row at all still reads, rather than 404-ing a
    // session that exists on disk.
    const unseen = '00000000000000e5';
    const unseenFile = path.join(ctx.logDir, 'sessions', `${unseen}.md`);
    await writeFile(
      unseenFile,
      '- session: s-9\n- started: 2026-07-15T19:00:00.000Z\n## Task: never ingested\n',
      'utf8',
    );
    expect(await dbSource(db).readSession(ctx.logDir, unseen)).toEqual(
      await fileSource.readSession(ctx.logDir, unseen),
    );

    // A transcript that is not there is still not there.
    await rm(unseenFile);
    await expect(dbSource(db).readSession(ctx.logDir, unseen)).rejects.toThrow(/session not found/);

    // Catch the corpus up, and the whole replay is still byte-identical.
    await ingest(db, ctx.logDir);
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  // `withCommandReconcile` writes the store and reads it back in the same
  // request, so rows behind the file would serve the pre-reconcile view. The
  // harness cannot reach that either — it reconciles once, before ingesting.
  it('re-reads the command store the rows are behind, rather than answering pre-reconcile', async () => {
    const store = commandStorePath(ctx.logDir);
    expect(await dbSource(db).readCommandRuns(ctx.logDir)).toEqual(await fileSource.readCommandRuns(ctx.logDir));

    // What a reconcile appends between two ingests: an existing run rewritten
    // as finished, which supersedes the row still in the table.
    const victim = (await fileSource.readCommandRuns(ctx.logDir)).find((r) => r.command === 'task');
    expect(victim, 'the corpus should hold a run to close out').toBeDefined();
    const closed = { ...victim!, ended: '2026-07-19T00:00:00.000Z' };
    await appendFile(store, `${JSON.stringify(closed)}\n`, 'utf8');

    const fromDb = await dbSource(db).readCommandRuns(ctx.logDir);
    expect(fromDb).toEqual(await fileSource.readCommandRuns(ctx.logDir));
    expect(fromDb.find((r) => r.command === 'task')?.ended).toBe(closed.ended);
    // Keyed by the record's own id, which is what the table stores: a nested run
    // shares its host's thread, so the thread id is not a key here.
    const row = db.prepare('SELECT ended FROM command_run WHERE run_id = ?').get(runKey(victim!)) as {
      ended: string | null;
    };
    expect(row.ended).toBe(victim!.ended);

    // Catch the corpus up, and the whole replay is still byte-identical.
    await ingest(db, ctx.logDir);
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  /**
   * The other half of that: the reconcile's own append, folded into the rows instead
   * of read back off disk. The re-read above is the fallback; this is the path
   * `/api/commands` actually takes.
   *
   * Parity is the point — the fold writes rows without a parse, and a wrong `ord`
   * would reorder two runs sharing a `started` without losing either, which only a
   * replay catches.
   */
  it('folds a reconcile append into the rows and still answers every route byte-identically', async () => {
    // A live run growing: one more turn on the parent's transcript, which is what
    // makes the pass rewrite that run's record. Ingested first, the way the watcher
    // would have — the transcript change is not what is under test here, and a
    // stale `session` row would fail the replay for its own reasons.
    await appendFile(
      path.join(ctx.logDir, 'sessions', '00000000000000a1.md'),
      '- Bash(command=my-command-tools verify)\n',
      'utf8',
    );
    await ingest(db, ctx.logDir);

    const result = await reconcileCommandRuns(ctx.logDir, ctx.commandsDir!, new Date('2026-07-19T00:00:00.000Z'));
    expect(result.appended, 'the grown transcript should have been rewritten').not.toBeNull();
    expect(applyCommandRunAppend(db, result.appended!), 'the rows sat level, so the fold applies').toBe(true);

    // The watermark moved with the rows, so `readCommandRuns` queries rather than
    // falling through to the file.
    const info = await stat(commandStorePath(ctx.logDir));
    expect(db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get('commands/runs.jsonl')).toEqual({
      bytes: info.size,
      modified: info.mtime.toISOString(),
    });
    expect(await dbSource(db).readCommandRuns(ctx.logDir)).toEqual(await fileSource.readCommandRuns(ctx.logDir));
    expect(await mismatches(ctx, db)).toEqual([]);

    // And a parse of the same store agrees position for position.
    const folded = db.prepare('SELECT run_id, ord, document FROM command_run ORDER BY ord').all();
    db.prepare('DELETE FROM file_watermark WHERE path = ?').run('commands/runs.jsonl');
    await ingest(db, ctx.logDir);
    expect(db.prepare('SELECT run_id, ord, document FROM command_run ORDER BY ord').all()).toEqual(folded);
    expect(await mismatches(ctx, db)).toEqual([]);
  });

  /**
   * The one write route through the seam. It stays out of `PARITY_ROUTES` —
   * replaying it against the real-corpus snapshot would write through a
   * hardlinked `suggestion-status.json` — so its agreement is asserted here,
   * where the write is ours to make.
   */
  it('answers the suggestion-status write the same way through either backing', async () => {
    const { buckets } = await buildSessionSuggestions(ctx.logDir, fileSource);
    const bucket = buckets[0];
    const suggestion = bucket?.suggestions[0];
    expect(suggestion, 'the corpus should hold a suggestion to flag').toBeDefined();
    if (!bucket || !suggestion) return;

    // Only the derived half — the bucket/suggestion join the response echoes
    // back — goes through the seam; the flags stay a JSON file either way. Same
    // clock and same update twice: the write is idempotent, which is what makes
    // the two answers comparable.
    const at = new Date('2026-07-18T00:00:00.000Z');
    const updates = [{ bucket: bucket.index, id: suggestion.id, status: 'done' as const, note: 'handled' }];
    const fromFiles = await applySuggestionStatus(ctx.logDir, updates, at, fileSource);
    const fromDb = await applySuggestionStatus(ctx.logDir, updates, at, dbSource(db));
    expect(JSON.stringify(fromDb)).toBe(JSON.stringify(fromFiles));
    expect(fromDb.rows).toHaveLength(1);
    expect(fromDb.meta.unknown).toEqual([]);
  });

  it('needs no normalization to agree', () => {
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
 * last user turn. It is write-once, so a hardlink freezes it.
 */
const SNAPSHOT_SUFFIXES = ['.audit.json', '.request.txt'];

/**
 * What `sessions/` contributes. Separate from {@link SNAPSHOT_SUFFIXES} because
 * `.md` means two things in this tree: a transcript under `sessions/`, and a
 * request's rendered body beside its audit sidecar. Taking the latter would
 * change which requests read as blob-evicted.
 */
const SESSION_SUFFIXES = ['.md', '.nodes.jsonl', '.state.json'];

/**
 * Live files a route reads that are not sidecars, and that get rewritten.
 *
 * Both are written temp-file-then-rename, so a hardlink genuinely freezes them:
 * the rename swaps the directory entry and leaves this snapshot's inode
 * untouched. `suggestion-status.json` never enters the DB — it is the right-hand
 * side of the join `/api/sessions/suggestions/status` replays.
 */
const SNAPSHOT_FILES = ['usage-live.json', 'suggestion-status.json'];

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
 *
 * **Which is why two concurrent runs cannot share one snapshot or one ingest**, even
 * though every worktree's `logs/` symlinks to the same checkout. The assertion is
 * `file-read(snapshot) === db-read(database)` and only holds while the two name the
 * same bytes. Two runs verifying at once are two agent sessions, each appending to
 * its own `sessions/<thread>.md` and to the shared `commands/runs.jsonl` as it goes,
 * so one run's database against the other's files disagrees — correctly, and about
 * nothing under test. Sharing the snapshot too would freeze the corpus at an instant
 * neither run chose and race one run's `afterAll` against the other's replay.
 */
async function snapshotLogs(logDir: string, days: string[]): Promise<string> {
  const snap = await mkdtemp(path.join(tmpdir(), 'parity-real-'));
  await linkInto(logDir, snap);
  const sessions = path.join(snap, 'sessions');
  await mkdir(sessions, { recursive: true });
  await linkInto(path.join(logDir, 'sessions'), sessions, SESSION_SUFFIXES, true);
  await mkdir(path.join(snap, 'commands'), { recursive: true });
  await copyFile(commandStorePath(logDir), commandStorePath(snap)).catch(() => {
    // No store on this machine yet: an empty commands page, not a failure.
  });
  for (const day of days) {
    const dest = path.join(snap, 'archive', day);
    await mkdir(dest, { recursive: true });
    await linkInto(path.join(logDir, 'archive', day), dest);
  }
  return snap;
}

/**
 * A frozen copy of the installed command catalogue. It lives outside `logs/`, but
 * a `/sync` landing between the two replays would still move it under them.
 */
async function snapshotCommandsDir(): Promise<string> {
  const snap = await mkdtemp(path.join(tmpdir(), 'parity-real-commands-'));
  await linkInto(resolveCommandsDir(), snap, ['.md'], true);
  return snap;
}

/**
 * A frozen copy of this machine's device settings, for `/api/withheld`.
 *
 * The shell rc that route also reads has no injection point, so it is read live
 * by both replays — nothing writes it automatically, so an edit landing between
 * the two reads would be a genuine difference in the input.
 */
async function snapshotSettings(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parity-real-settings-'));
  const dest = path.join(dir, 'settings.json');
  await copyFile(resolveSettingsPath(), dest).catch(() => {
    // No settings on this machine: a state the route already handles, and both
    // sides see it alike.
  });
  return dest;
}

/**
 * How many archived days the real-corpus replay covers by default, counting back
 * from the most recent.
 *
 * The whole archive was the corpus until this cap, and that cost is linear in a
 * directory that only ever grows: at 24 days, `beforeAll` snapshots it and ingests
 * it single-threaded into a ~1.4 GB database before the first assertion runs — 7-15
 * minutes of every `my-command-tools verify`, on one pinned core.
 *
 * Five is what a parity defect needs to surface. The suite compares two readers of
 * the same row *shapes*, so a disagreement reproduces on any day carrying the shape
 * rather than on one particular day; the days are near-identical samples, not
 * independent ones.
 *
 * `PARITY_DAYS=all` restores the full sweep — the run to make before a substrate
 * change lands. A positive integer sets the cap instead, for bisecting a day back
 * into range.
 */
const DEFAULT_REAL_DAYS = 5;

/**
 * The most recent `PARITY_DAYS` entries of `days`, which arrive oldest first.
 *
 * Neither `all` nor a positive integer throws rather than falling back, since a
 * typo'd override would otherwise replay five days for someone who asked for all of
 * them and say nothing.
 */
function capDays(days: string[], raw: string | undefined = process.env.PARITY_DAYS): string[] {
  if (raw === undefined || raw === '') return days.slice(-DEFAULT_REAL_DAYS);
  if (raw.toLowerCase() === 'all') return days;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`PARITY_DAYS must be "all" or a positive integer, got ${JSON.stringify(raw)}`);
  }
  return days.slice(-limit);
}

/**
 * This machine's archived days, listed while the suite is being *collected* —
 * which is what lets each day be named as its own case below. `beforeAll` is a
 * tick too late: by then the cases are already fixed.
 *
 * Capped to the most recent {@link DEFAULT_REAL_DAYS}; see {@link capDays}.
 */
const REAL_DAYS = capDays(archivedDaysSync(resolveLogDir()));

describe('the archived-day cap', () => {
  const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];

  it('keeps the most recent days, newest last', () => {
    expect(capDays(days, undefined)).toEqual(days.slice(1));
    expect(capDays(days, '')).toEqual(days.slice(1));
    expect(capDays(days, '2')).toEqual(['2026-08-05', '2026-08-06']);
  });

  it('restores the full sweep on `all`, whatever case it is written in', () => {
    expect(capDays(days, 'all')).toEqual(days);
    expect(capDays(days, 'ALL')).toEqual(days);
  });

  it('asks for no more days than there are', () => {
    expect(capDays(days, '99')).toEqual(days);
    expect(capDays([], undefined)).toEqual([]);
  });

  // The one case that must not read as the default, since it would silently narrow
  // a sweep someone asked for in full.
  it('refuses a value that is neither `all` nor a positive count', () => {
    for (const raw of ['alll', '0', '-1', '2.5', 'five']) {
      expect(() => capDays(days, raw), raw).toThrow(/PARITY_DAYS/);
    }
  });
});

/**
 * The split the cases below are drawn along: a `perDay` route gets one case per
 * archived day, everything else is replayed once.
 */
const PER_DAY_ROUTES = PARITY_ROUTES.filter((r) => r.perDay);
const WHOLE_ROUTES = PARITY_ROUTES.filter((r) => !r.perDay);

/**
 * The same replay against this machine's real archive, snapshotted first.
 * Skipped where there is no archive to replay — a clean clone, or CI.
 *
 * One case per archived day, rather than one case for all of them. What is
 * compared is unchanged, but the archive only ever grows, so a single case
 * carrying the sum of every day outgrows any budget it is given, and did.
 *
 * The days replayed are the most recent {@link DEFAULT_REAL_DAYS}, which keeps the
 * *suite* from outgrowing its budget the way a single case did. `PARITY_DAYS=all`
 * restores the full sweep.
 */
describe('route parity over the real logs/archive', () => {
  let snapshot: string | null = null;
  let commandsDir: string | null = null;
  let settingsPath: string | null = null;
  let db: DatabaseSync | null = null;

  beforeAll(async () => {
    if (!REAL_DAYS.length) return;
    snapshot = await snapshotLogs(resolveLogDir(), REAL_DAYS);
    commandsDir = await snapshotCommandsDir();
    settingsPath = await snapshotSettings();
    db = openDb(snapshot);
    await ingest(db, snapshot);
    // Once for the suite rather than once per case: every memo keys on the
    // backing that filled it and the directory it read, so a warm cache cannot
    // let one backing answer for the other, while dropping it between days would
    // re-read the whole archive once per day.
    resetCaches();
  }, 300_000);

  // The same budget `beforeAll` gets, and for the same reason: what this tears
  // down is a snapshot of the real archive, which is 17 GB across 24 days on the
  // device this suite actually runs on. Deleting that does not fit in vitest's
  // 10s default, so the hook timed out and failed the suite while all 700 cases
  // passed — the teardown, never an assertion. Same growth that #183 bounded the
  // replay for; this is the other end of it.
  afterAll(async () => {
    db?.close();
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
    if (commandsDir) await rm(commandsDir, { recursive: true, force: true });
  }, 300_000);

  /** The frozen corpus, with the days scoped to `days` when a case replays a subset. */
  function contextFor(days?: string[]): ParityContext {
    return {
      logDir: snapshot ?? '',
      days,
      limits: resolveUsageLimits({}),
      commandsDir: commandsDir ?? undefined,
      settingsPath: settingsPath ?? undefined,
    };
  }

  it('snapshots the archive it is about to replay', async () => {
    if (!REAL_DAYS.length || !snapshot) return;
    expect(await archivedDays(snapshot)).toEqual(REAL_DAYS);
    expect((await stat(path.join(snapshot, 'archive', REAL_DAYS[0]!))).isDirectory()).toBe(true);
  });

  // Nothing archived is the clean-clone and CI case: there is no corpus to
  // replay, and saying so is the whole of what this suite can assert there.
  if (!REAL_DAYS.length) {
    it('has no archived day to replay', () => {
      expect(REAL_DAYS).toEqual([]);
    });
    return;
  }

  it.each(REAL_DAYS)(
    'answers every dated route byte-identically for %s',
    async (day) => {
      if (!db) return;
      const { diffs, cases } = await replay(contextFor([day]), db, PER_DAY_ROUTES);
      expect(cases, 'the harness replayed nothing, so it proved nothing').toBeGreaterThan(0);
      expect(diffs).toEqual([]);
    },
    300_000,
  );

  // One case per undated route, for the reason the days are split: replayed
  // together these overran the same budget on their own. Each route's own case
  // count is already capped in `parity.ts` — by transcript, by run and by prompt
  // cohort — so a route is where the cost stops growing.
  for (const route of WHOLE_ROUTES) {
    it(`answers ${route.name} byte-identically`, async () => {
      if (!db) return;
      expect((await replay(contextFor(), db, [route])).diffs).toEqual([]);
    }, 300_000);
  }
});
