import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COMMAND_RUN_SCHEMA } from '@claude-proxy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendCommandRuns,
  commandStorePath,
  listInstalledCommands,
  readCommandRuns,
  readRequestIndex,
  reconcileCommandRuns,
  requestIndexPath,
  resolveCommandsDir,
} from '../src/command-runs.js';

const COMMAND_FILE = `---
description: Ship a task.
---

Do the thing.

## Step 1 — Set up the workspace

Run \`my-command-tools worktree begin\` first.

## Step 2 — Implement

Verify with \`my-command-tools verify\`.

## Notes

Never commit on main.
`;

/** The proxy's own naming: filename prefix is the UTC instant, `:`/`.` flattened. */
function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

function envelope(command: string, args: string): string {
  return `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${args}</command-args>`;
}

/** The thread id the proxy would have derived, so transcript and body agree. */
function threadIdFor(sessionId: string, root: string): string {
  return crypto.createHash('sha256').update(`${sessionId}\n${root}`).digest('hex').slice(0, 16);
}

let logDir: string;
let commandsDir: string;

interface Capture {
  iso: string;
  sessionId: string;
  root: string;
  /**
   * How many transcript nodes the run had produced when this request went out — the
   * root task plus one per assistant turn. This is what places the request on the spine.
   */
  nodes: number;
  realInput?: number;
}

async function writeCapture(c: Capture): Promise<void> {
  const stem = stemFor(c.iso);
  const realInput = c.realInput ?? 1000;
  await writeFile(
    path.join(logDir, `${stem}.audit.json`),
    JSON.stringify({
      timestamp: c.iso,
      model: 'claude-opus-5',
      session: { sessionId: c.sessionId },
      tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0, realInput },
      request: { toolCount: 3, toolsBytes: 400, systemBytes: 900, totalBytes: 5000 },
      tools: ['Read', 'Edit', 'Bash'],
    }),
    'utf8',
  );

  // The body only has to carry a user root and enough turns to place the request: the
  // root becomes one node, each assistant turn one more.
  const messages: unknown[] = [{ role: 'user', content: c.root }];
  for (let i = 1; i < c.nodes; i += 1) messages.push({ role: 'assistant', content: `turn ${i}` });
  await writeFile(path.join(logDir, `${stem}.request.txt`), JSON.stringify({ messages }), 'utf8');
}

async function writeSession(threadId: string, sessionId: string, root: string, body: string): Promise<void> {
  const dir = path.join(logDir, 'sessions');
  await writeFile(
    path.join(dir, `${threadId}.md`),
    `# Session ${threadId}\n- model: claude-opus-5\n- session: ${sessionId}\n- started: 2026-07-15T14:00:00.000Z\n\n\n## Task: ${root.slice(0, 60)}\n${body}\n`,
    'utf8',
  );
  await writeFile(
    path.join(dir, `${threadId}.state.json`),
    JSON.stringify({ count: 1, started: '2026-07-15T14:00:00.000Z', root }),
    'utf8',
  );
}

const ROOT = `${envelope('task', 'add a commands page')}\n\nadd a commands page`;
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const THREAD_ID = threadIdFor(SESSION_ID, ROOT);

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'command-runs-'));
  commandsDir = await mkdtemp(path.join(tmpdir(), 'commands-'));
  await mkdir(path.join(logDir, 'sessions'), { recursive: true });
  await writeFile(path.join(commandsDir, 'task.md'), COMMAND_FILE, 'utf8');
});

describe('listInstalledCommands', () => {
  it('parses each `*.md` into steps and a content hash', async () => {
    const installed = await listInstalledCommands(commandsDir);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.command).toBe('task');
    expect(installed[0]!.steps.map((s) => s.id)).toEqual(['1', '2']);
    expect(installed[0]!.commandHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the file byte for byte, which is what the command page renders', async () => {
    const installed = await listInstalledCommands(commandsDir);
    expect(installed[0]!.content).toBe(COMMAND_FILE);
  });

  it('treats a machine with no commands directory as empty, not broken', async () => {
    expect(await listInstalledCommands(path.join(commandsDir, 'nope'))).toEqual([]);
  });

  it('moves the hash when the file changes, which is what marks a `/sync` on the timeline', async () => {
    const before = (await listInstalledCommands(commandsDir))[0]!.commandHash;
    await writeFile(path.join(commandsDir, 'task.md'), `${COMMAND_FILE}\nOne more line.\n`, 'utf8');
    expect((await listInstalledCommands(commandsDir))[0]!.commandHash).not.toBe(before);
  });
});

describe('resolveCommandsDir', () => {
  it('honours COMMANDS_DIR over the install default', () => {
    expect(resolveCommandsDir({ COMMANDS_DIR: '/tmp/x' } as NodeJS.ProcessEnv)).toBe(path.resolve('/tmp/x'));
    expect(resolveCommandsDir({} as NodeJS.ProcessEnv)).toMatch(/\.claude\/commands$/);
  });
});

describe('the store', () => {
  it('reads as empty before anything is written', async () => {
    expect(await readCommandRuns(logDir)).toEqual([]);
  });

  it('lets a later line supersede an earlier one for the same thread', async () => {
    const base = { schema: COMMAND_RUN_SCHEMA, threadId: 'a'.repeat(16), command: 'task' } as never;
    await appendCommandRuns(logDir, [
      { ...(base as object), started: '2026-07-15T14:00:00.000Z', totals: { turns: 1 } } as never,
      { ...(base as object), started: '2026-07-15T14:00:00.000Z', totals: { turns: 9 } } as never,
    ]);
    const runs = await readCommandRuns(logDir);
    expect(runs).toHaveLength(1);
    expect((runs[0] as unknown as { totals: { turns: number } }).totals.turns).toBe(9);
  });

  it('skips a torn final line rather than losing the file', async () => {
    await appendCommandRuns(logDir, [
      { schema: COMMAND_RUN_SCHEMA, threadId: 'b'.repeat(16), command: 'task' } as never,
    ]);
    await writeFile(commandStorePath(logDir), `${await readFile(commandStorePath(logDir), 'utf8')}{"threadId":`, {
      encoding: 'utf8',
    });
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  // A schema bump must degrade the page's detail, never empty it.
  it('keeps a record written by a future schema version', async () => {
    await appendCommandRuns(logDir, [
      { schema: COMMAND_RUN_SCHEMA + 99, threadId: 'c'.repeat(16), command: 'task', newField: 1 } as never,
    ]);
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  it("drops a line that isn't a run record at all", async () => {
    await mkdir(path.dirname(commandStorePath(logDir)), { recursive: true });
    await writeFile(commandStorePath(logDir), `{"hello":"world"}\n[]\n"nope"\n`, 'utf8');
    expect(await readCommandRuns(logDir)).toEqual([]);
  });
});

describe('the request index', () => {
  it('reads as empty when absent, corrupt, or from another schema', async () => {
    expect((await readRequestIndex(logDir)).entries).toEqual({});
    await mkdir(path.dirname(requestIndexPath(logDir)), { recursive: true });
    await writeFile(requestIndexPath(logDir), '{ not json', 'utf8');
    expect((await readRequestIndex(logDir)).entries).toEqual({});
    await writeFile(requestIndexPath(logDir), JSON.stringify({ schema: 99, entries: { a: {} } }), 'utf8');
    expect((await readRequestIndex(logDir)).entries).toEqual({});
  });
});

describe('reconcileCommandRuns', () => {
  it('writes nothing when no session carries a command envelope', async () => {
    await writeSession(THREAD_ID, SESSION_ID, 'just a plain question', '- decided: hi');
    expect(await reconcileCommandRuns(logDir, commandsDir)).toMatchObject({ written: 0, runs: 0 });
  });

  it('distils a run, placing its turns against the steps their artifacts anchor', async () => {
    await writeSession(
      THREAD_ID,
      SESSION_ID,
      ROOT,
      [
        '- decided: starting',
        '- Bash(command=my-command-tools worktree begin --branch feat/x)',
        '- Edit(file_path=/repo/a.ts)',
        '- Bash(command=my-command-tools verify)',
        '- done: shipped it',
      ].join('\n'),
    );
    await writeCapture({ iso: '2026-07-15T14:00:30.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 1 });
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 3 });
    await writeCapture({ iso: '2026-07-15T14:02:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 9 });

    const result = await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
    expect(result).toMatchObject({ written: 1, runs: 1, requestsRead: 3, capped: false });

    const [run] = await readCommandRuns(logDir);
    expect(run!.command).toBe('task');
    expect(run!.args).toBe('add a commands page');
    expect(run!.threadIds).toEqual([THREAD_ID]);
    expect(run!.steps.map((s) => s.id)).toEqual(['1', '2']);
    expect(run!.commandHash).toMatch(/^[0-9a-f]{16}$/);
    expect(run!.totals.turns).toBe(3);
    expect(run!.totals.tokens.realInput).toBe(3000);
    expect(run!.totals.cost).toBeGreaterThan(0);
    expect(run!.totals.toolCalls).toBe(3);
    // The last declared step was reached and the transcript said `- done:`.
    expect(run!.reachedEnd).toBe(true);
    expect(run!.outcome).toBe('completed');
    // The opening request predates every anchor, so it lands in the unattributed gutter
    // rather than being charged to step 1 by proximity; the next sits on the
    // `worktree begin` anchor, and the last is past `verify`.
    expect(run!.turns.map((t) => t.step)).toEqual([null, '1', '2']);
    expect(run!.meta.turnsUnmapped).toBe(1);
    expect(run!.turns[0]!.systemBytes).toBe(900);
    expect(run!.turns[0]!.messageCount).toBeGreaterThan(0);
  });

  it('strips the command envelope off the stored prompt', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- done: ok');
    await reconcileCommandRuns(logDir, commandsDir);
    const [run] = await readCommandRuns(logDir);
    expect(run!.prompt).not.toContain('<command-name>');
    expect(run!.prompt).toContain('add a commands page');
  });

  it('is idempotent: a second pass rewrites nothing and reopens no bodies', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Bash(command=my-command-tools verify)\n- done: ok');
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });

    const now = new Date('2026-07-15T18:00:00.000Z');
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 1, requestsRead: 1 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 0, requestsRead: 0 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 0, requestsRead: 0 });
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  it('rewrites the record as the run grows, so the page can follow it live', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- decided: starting');
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    const now = new Date('2026-07-15T18:00:00.000Z');
    await reconcileCommandRuns(logDir, commandsDir, now);
    expect((await readCommandRuns(logDir))[0]!.totals.turns).toBe(1);

    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- decided: starting\n- Bash(command=my-command-tools verify)');
    await writeCapture({ iso: '2026-07-15T14:03:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 6 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 1, requestsRead: 1 });
    expect((await readCommandRuns(logDir))[0]!.totals.turns).toBe(2);
  });

  // Sidecars are archived and then pruned. A turn's tokens must survive that, because
  // the record becomes the only evidence they were ever spent.
  it('keeps turns whose captured requests have since aged out', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- done: ok');
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    const now = new Date('2026-07-15T18:00:00.000Z');
    await reconcileCommandRuns(logDir, commandsDir, now);

    const { rm } = await import('node:fs/promises');
    const stem = stemFor('2026-07-15T14:01:00.000Z');
    await rm(path.join(logDir, `${stem}.audit.json`));
    await rm(path.join(logDir, `${stem}.request.txt`));

    await reconcileCommandRuns(logDir, commandsDir, now);
    const [run] = await readCommandRuns(logDir);
    expect(run!.totals.turns).toBe(1);
    expect(run!.totals.tokens.realInput).toBe(1000);
    expect(run!.model).toBe('claude-opus-5');
  });

  it("rolls a subagent's turns up into the run that spawned it", async () => {
    const subRoot = 'go and research the thing';
    const subThread = threadIdFor(SESSION_ID, subRoot);
    await writeSession(
      THREAD_ID,
      SESSION_ID,
      ROOT,
      [
        '- Bash(command=my-command-tools verify)',
        `- Agent(subagent_type=Explore, threadId=${subThread})`,
        '- done: ok',
      ].join('\n'),
    );
    await writeSession(subThread, SESSION_ID, subRoot, '- decided: looking');
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    await writeCapture({ iso: '2026-07-15T14:02:00.000Z', sessionId: SESSION_ID, root: subRoot, nodes: 2 });

    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
    const run = (await readCommandRuns(logDir)).find((r) => r.threadId === THREAD_ID)!;
    expect(run.threadIds).toContain(subThread);
    expect(run.totals.turns).toBe(2);
    // The delegated turn is charged to the step that chose to delegate.
    expect(run.turns.find((t) => t.threadId === subThread)!.step).toBe('2');
  });

  it('still renders a run whose command has been uninstalled, against the steps it ran under', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Bash(command=my-command-tools verify)\n- done: ok');
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));

    const gone = await mkdtemp(path.join(tmpdir(), 'commands-gone-'));
    await reconcileCommandRuns(logDir, gone, new Date('2026-07-15T18:00:00.000Z'));
    const [run] = await readCommandRuns(logDir);
    expect(run!.steps.map((s) => s.id)).toEqual(['1', '2']);
  });

  // A local command never reaches the model, so the tokens of a session it opened belong
  // to whatever was asked next.
  describe('a session opened by a local command', () => {
    const CAVEAT =
      '<local-command-caveat>Caveat: The messages below were generated by the user while running local ' +
      'commands.</local-command-caveat>';
    const CLEAR = `${CAVEAT} <command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args> <local-command-stdout></local-command-stdout>`;

    it('is the run of the command typed after it, charged for its own turns', async () => {
      const root = `${CLEAR} ${envelope('task', 'add a commands page')}`;
      const threadId = threadIdFor(SESSION_ID, root);
      await writeSession(threadId, SESSION_ID, root, '- Bash(command=my-command-tools verify)\n- done: ok');
      await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root, nodes: 2 });

      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      const [run] = await readCommandRuns(logDir);
      expect(run!.command).toBe('task');
      expect(run!.prompt).toBe('add a commands page');
      expect(run!.totals.turns).toBe(1);
    });

    it('is not a run at all when nothing was asked after it', async () => {
      const root = `${CLEAR} Strange, the overview page shows nothing when today is empty.`;
      const threadId = threadIdFor(SESSION_ID, root);
      await writeSession(threadId, SESSION_ID, root, '- Bash(command=rg -n usage)\n- done: fixed');
      await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root, nodes: 2 });

      expect(await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'))).toMatchObject({
        written: 0,
        runs: 0,
      });
      expect(await readCommandRuns(logDir)).toEqual([]);
    });

    it('retires a record whose thread no longer reads as a run', async () => {
      const root = `${CLEAR} Strange, the overview page shows nothing when today is empty.`;
      const threadId = threadIdFor(SESSION_ID, root);
      await writeSession(threadId, SESSION_ID, root, '- done: fixed');
      await appendCommandRuns(logDir, [
        {
          schema: COMMAND_RUN_SCHEMA,
          threadId,
          command: 'clear',
          started: '2026-07-15T14:00:00.000Z',
          totals: { cost: 17.05, turns: 60 },
        } as never,
      ]);
      expect(await readCommandRuns(logDir)).toHaveLength(1);

      expect(await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'))).toMatchObject({
        written: 1,
        runs: 0,
      });
      expect(await readCommandRuns(logDir)).toEqual([]);
      expect(await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'))).toMatchObject({
        written: 0,
      });
    });

    // Without an opening prompt there is nothing to retire the record on, and the record is
    // the only surviving account of the run.
    it('keeps a record whose transcript survives but whose opening prompt does not', async () => {
      await writeSession(THREAD_ID, SESSION_ID, ROOT, '- done: ok');
      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      expect(await readCommandRuns(logDir)).toHaveLength(1);

      const sidecar = path.join(logDir, 'sessions', `${THREAD_ID}.state.json`);
      await rm(sidecar);
      expect(await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'))).toMatchObject({
        written: 0,
      });
      expect(await readCommandRuns(logDir)).toHaveLength(1);

      // The proxy only records `root` once it has a prompt to record, so a sidecar without
      // one is the same silence as no sidecar at all.
      await writeFile(sidecar, JSON.stringify({ count: 1, root: null }), 'utf8');
      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      expect(await readCommandRuns(logDir)).toHaveLength(1);
    });

    it("carries a retired record's turns back if its thread reads as a run again", async () => {
      await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Bash(command=my-command-tools verify)\n- done: ok');
      await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      expect((await readCommandRuns(logDir))[0]!.totals.turns).toBe(1);

      const sidecar = path.join(logDir, 'sessions', `${THREAD_ID}.state.json`);
      const state = await readFile(sidecar, 'utf8');
      await writeFile(sidecar, JSON.stringify({ count: 1, root: 'just a normal prompt' }), 'utf8');
      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      expect(await readCommandRuns(logDir)).toEqual([]);

      // The request body was already indexed, so the turns can only come from the record.
      await writeFile(sidecar, state, 'utf8');
      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      const [run] = await readCommandRuns(logDir);
      expect(run!.totals.turns).toBe(1);
    });

    it('leaves a record alone when its transcript has aged out of the log window', async () => {
      await appendCommandRuns(logDir, [
        { schema: COMMAND_RUN_SCHEMA, threadId: 'd'.repeat(16), command: 'task' } as never,
      ]);
      await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
      expect(await readCommandRuns(logDir)).toHaveLength(1);
    });
  });

  it('records a run with no captured requests rather than dropping it', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- decided: started, then the logs aged out');
    expect(await reconcileCommandRuns(logDir, commandsDir)).toMatchObject({ written: 1 });
    const [run] = await readCommandRuns(logDir);
    expect(run!.turns).toEqual([]);
    expect(run!.totals.turns).toBe(0);
    expect(run!.totals.tokens.realInput).toBe(0);
  });
});

// A `/clean` or `/pr` never opens a session — it is invoked from inside a `/task`, and the
// CLI expands it client-side, so there is no envelope to find. The `Skill(...)` node is the
// only durable evidence, and each nested run is a slice of its host's own transcript.
describe('nested runs', () => {
  /** A `/task` that verifies, then hands off to `/clean` and `/pr`. */
  const NESTED_BODY = [
    '- decided: starting',
    '- Bash(command=my-command-tools verify)',
    '- Skill(skill=clean)',
    '- Edit(file_path=/repo/a.ts)',
    '- Skill(skill=/pr)',
    '- Bash(command=git push -u origin HEAD)',
    '- done: opened the PR',
  ].join('\n');

  beforeEach(async () => {
    await writeFile(path.join(commandsDir, 'clean.md'), '---\ndescription: Tidy up.\n---\n\nTidy.\n', 'utf8');
    await writeFile(path.join(commandsDir, 'pr.md'), '---\ndescription: Open a PR.\n---\n\nShip.\n', 'utf8');
  });

  it('opens a child run per invocation, parented to the run that made it', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, NESTED_BODY);
    const result = await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
    expect(result).toMatchObject({ written: 3, runs: 3 });

    const runs = await readCommandRuns(logDir);
    const parent = runs.find((r) => r.command === 'task')!;
    const clean = runs.find((r) => r.command === 'clean')!;
    const pr = runs.find((r) => r.command === 'pr')!;

    // The parent keeps its thread id as its key, so links written before this schema still resolve.
    expect(parent.runId).toBe(THREAD_ID);
    expect(parent.parentRunId).toBeNull();
    expect(parent.nodeRange).toBeNull();

    for (const child of [clean, pr]) {
      expect(child.runId).toBe(`${THREAD_ID}~${child.spawnNode}`);
      expect(child.parentRunId).toBe(THREAD_ID);
      expect(child.parentCommand).toBe('task');
      expect(child.threadId).toBe(THREAD_ID);
    }
    // Each span starts on its own `Skill` node and ends where the next one begins.
    expect(clean.nodeRange!.to).toBe(pr.nodeRange!.from);
    expect(clean.nodeRange!.from).toBeLessThan(clean.nodeRange!.to);
    expect(pr.spawnNode).toBe(pr.nodeRange!.from);
  });

  it("ignores a plain skill that isn't an installed command", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Skill(skill=grilling)\n- done: ok');
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  it("partitions the host's turns without charging one twice, while the parent still totals them all", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, NESTED_BODY);
    // One capture before `/clean`, one inside it, one inside `/pr`.
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    await writeCapture({ iso: '2026-07-15T14:02:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 4 });
    await writeCapture({ iso: '2026-07-15T14:03:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 6 });

    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
    const runs = await readCommandRuns(logDir);
    const parent = runs.find((r) => r.command === 'task')!;
    const clean = runs.find((r) => r.command === 'clean')!;
    const pr = runs.find((r) => r.command === 'pr')!;

    expect(parent.totals.turns).toBe(3);
    expect(clean.totals.turns + pr.totals.turns).toBeLessThanOrEqual(parent.totals.turns);
    const nodes = [...clean.turns, ...pr.turns].map((t) => t.node);
    expect(new Set(nodes).size).toBe(nodes.length);
    for (const turn of clean.turns) {
      expect(turn.node).toBeGreaterThanOrEqual(clean.nodeRange!.from);
      expect(turn.node).toBeLessThan(clean.nodeRange!.to);
    }
    // The child's cost is real, not a copy of its parent's.
    expect(pr.totals.tokens.realInput).toBeLessThan(parent.totals.tokens.realInput);
  });

  it('upserts child runs too: a second pass writes nothing and reopens no bodies', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, NESTED_BODY);
    await writeCapture({ iso: '2026-07-15T14:02:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 4 });

    const now = new Date('2026-07-15T18:00:00.000Z');
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 3, requestsRead: 1 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 0, requestsRead: 0 });
    expect(await readCommandRuns(logDir)).toHaveLength(3);
  });

  it('gives a child only the subagents spawned inside its own span', async () => {
    const subRoot = 'review the diff';
    const subThread = threadIdFor(SESSION_ID, subRoot);
    await writeSession(
      THREAD_ID,
      SESSION_ID,
      ROOT,
      [
        '- decided: starting',
        '- Skill(skill=clean)',
        `- Agent(subagent_type=Explore, threadId=${subThread})`,
        '- done: ok',
      ].join('\n'),
    );
    await writeSession(subThread, SESSION_ID, subRoot, '- decided: reviewing');

    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));
    const runs = await readCommandRuns(logDir);
    expect(runs.find((r) => r.command === 'clean')!.threadIds).toContain(subThread);
    // And the parent still owns it, because a nested run is a slice of the parent, not a hole in it.
    expect(runs.find((r) => r.command === 'task')!.threadIds).toContain(subThread);
  });

  // `/clean` and `/pr` declare no `## Step N` headings, so a child has one unattributed
  // bucket. Its duration, cost, and outcome are still its own.
  it('still records a child whose command declares no steps', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Skill(skill=clean)\n- done: ok');
    await writeCapture({ iso: '2026-07-15T14:02:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 3 });
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));

    const clean = (await readCommandRuns(logDir)).find((r) => r.command === 'clean')!;
    expect(clean.steps).toEqual([]);
    expect(clean.turns.every((t) => t.step === null)).toBe(true);
    expect(clean.totals.tokens.realInput).toBeGreaterThan(0);
    expect(clean.prompt).toBe('');
  });

  it('measures a child across its requests, having no session bracket of its own', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Skill(skill=clean)\n- done: ok');
    await writeCapture({ iso: '2026-07-15T14:02:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 3 });
    await writeCapture({ iso: '2026-07-15T14:05:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 4 });
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));

    const clean = (await readCommandRuns(logDir)).find((r) => r.command === 'clean')!;
    // The host's transcript brackets the host, not this slice of it.
    expect(clean.totals.wallMs).toBe(clean.totals.durationMs);
    expect(clean.totals.durationMs).toBe(3 * 60_000);
  });
});

describe('end-to-end duration', () => {
  it('brackets a top-level run by its transcript, which is wider than its request span', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- Bash(command=my-command-tools verify)\n- done: ok');
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    await writeCapture({ iso: '2026-07-15T14:04:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 3 });
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));

    const [run] = await readCommandRuns(logDir);
    // The transcript opens before the first request and is written after the last.
    expect(run!.totals.durationMs).toBe(3 * 60_000);
    expect(run!.totals.wallMs).toBeGreaterThan(run!.totals.durationMs);
  });

  it('gives a single-turn run a duration, where the request span reports none', async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, '- done: ok');
    await writeCapture({ iso: '2026-07-15T14:01:00.000Z', sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    await reconcileCommandRuns(logDir, commandsDir, new Date('2026-07-15T18:00:00.000Z'));

    const [run] = await readCommandRuns(logDir);
    // One request is its own first and last, so the span between them is zero.
    expect(run!.totals.durationMs).toBe(0);
    expect(run!.totals.wallMs).toBeGreaterThan(0);
  });
});
