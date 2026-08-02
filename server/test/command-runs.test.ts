import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { COMMAND_RUN_SCHEMA } from "@claude-proxy/core";
import {
  appendCommandRuns,
  commandStorePath,
  listInstalledCommands,
  readCommandRuns,
  readRequestIndex,
  reconcileCommandRuns,
  requestIndexPath,
  resolveCommandsDir,
} from "../src/command-runs.js";

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
  return `${iso.replace(/:/g, "-").replace(".", "-").replace("Z", "")}_anthropic`;
}

function envelope(command: string, args: string): string {
  return `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${args}</command-args>`;
}

/** The thread id the proxy would have derived, so transcript and body agree. */
function threadIdFor(sessionId: string, root: string): string {
  return crypto.createHash("sha256").update(`${sessionId}\n${root}`).digest("hex").slice(0, 16);
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
      model: "claude-opus-5",
      session: { sessionId: c.sessionId },
      tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0, realInput },
      request: { toolCount: 3, toolsBytes: 400, systemBytes: 900, totalBytes: 5000 },
      tools: ["Read", "Edit", "Bash"],
    }),
    "utf8",
  );

  // The body only has to carry a user root and enough turns to place the request: the
  // root becomes one node, each assistant turn one more.
  const messages: unknown[] = [{ role: "user", content: c.root }];
  for (let i = 1; i < c.nodes; i += 1) messages.push({ role: "assistant", content: `turn ${i}` });
  await writeFile(path.join(logDir, `${stem}.request.txt`), JSON.stringify({ messages }), "utf8");
}

async function writeSession(threadId: string, sessionId: string, root: string, body: string): Promise<void> {
  const dir = path.join(logDir, "sessions");
  await writeFile(
    path.join(dir, `${threadId}.md`),
    `# Session ${threadId}\n- model: claude-opus-5\n- session: ${sessionId}\n- started: 2026-07-15T14:00:00.000Z\n\n\n## Task: ${root.slice(0, 60)}\n${body}\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, `${threadId}.state.json`),
    JSON.stringify({ count: 1, started: "2026-07-15T14:00:00.000Z", root }),
    "utf8",
  );
}

const ROOT = `${envelope("task", "add a commands page")}\n\nadd a commands page`;
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const THREAD_ID = threadIdFor(SESSION_ID, ROOT);

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), "command-runs-"));
  commandsDir = await mkdtemp(path.join(tmpdir(), "commands-"));
  await mkdir(path.join(logDir, "sessions"), { recursive: true });
  await writeFile(path.join(commandsDir, "task.md"), COMMAND_FILE, "utf8");
});

describe("listInstalledCommands", () => {
  it("parses each `*.md` into steps and a content hash", async () => {
    const installed = await listInstalledCommands(commandsDir);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.command).toBe("task");
    expect(installed[0]!.steps.map((s) => s.id)).toEqual(["1", "2"]);
    expect(installed[0]!.commandHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats a machine with no commands directory as empty, not broken", async () => {
    expect(await listInstalledCommands(path.join(commandsDir, "nope"))).toEqual([]);
  });

  it("moves the hash when the file changes, which is what marks a `/sync` on the timeline", async () => {
    const before = (await listInstalledCommands(commandsDir))[0]!.commandHash;
    await writeFile(path.join(commandsDir, "task.md"), `${COMMAND_FILE}\nOne more line.\n`, "utf8");
    expect((await listInstalledCommands(commandsDir))[0]!.commandHash).not.toBe(before);
  });
});

describe("resolveCommandsDir", () => {
  it("honours COMMANDS_DIR over the install default", () => {
    expect(resolveCommandsDir({ COMMANDS_DIR: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(path.resolve("/tmp/x"));
    expect(resolveCommandsDir({} as NodeJS.ProcessEnv)).toMatch(/\.claude\/commands$/);
  });
});

describe("the store", () => {
  it("reads as empty before anything is written", async () => {
    expect(await readCommandRuns(logDir)).toEqual([]);
  });

  it("lets a later line supersede an earlier one for the same thread", async () => {
    const base = { schema: COMMAND_RUN_SCHEMA, threadId: "a".repeat(16), command: "task" } as never;
    await appendCommandRuns(logDir, [
      { ...(base as object), started: "2026-07-15T14:00:00.000Z", totals: { turns: 1 } } as never,
      { ...(base as object), started: "2026-07-15T14:00:00.000Z", totals: { turns: 9 } } as never,
    ]);
    const runs = await readCommandRuns(logDir);
    expect(runs).toHaveLength(1);
    expect((runs[0] as unknown as { totals: { turns: number } }).totals.turns).toBe(9);
  });

  it("skips a torn final line rather than losing the file", async () => {
    await appendCommandRuns(logDir, [
      { schema: COMMAND_RUN_SCHEMA, threadId: "b".repeat(16), command: "task" } as never,
    ]);
    await writeFile(commandStorePath(logDir), `${await readFile(commandStorePath(logDir), "utf8")}{"threadId":`, {
      encoding: "utf8",
    });
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  // A schema bump must degrade the page's detail, never empty it.
  it("keeps a record written by a future schema version", async () => {
    await appendCommandRuns(logDir, [
      { schema: COMMAND_RUN_SCHEMA + 99, threadId: "c".repeat(16), command: "task", newField: 1 } as never,
    ]);
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  it("drops a line that isn't a run record at all", async () => {
    await mkdir(path.dirname(commandStorePath(logDir)), { recursive: true });
    await writeFile(commandStorePath(logDir), `{"hello":"world"}\n[]\n"nope"\n`, "utf8");
    expect(await readCommandRuns(logDir)).toEqual([]);
  });
});

describe("the request index", () => {
  it("reads as empty when absent, corrupt, or from another schema", async () => {
    expect((await readRequestIndex(logDir)).entries).toEqual({});
    await mkdir(path.dirname(requestIndexPath(logDir)), { recursive: true });
    await writeFile(requestIndexPath(logDir), "{ not json", "utf8");
    expect((await readRequestIndex(logDir)).entries).toEqual({});
    await writeFile(requestIndexPath(logDir), JSON.stringify({ schema: 99, entries: { a: {} } }), "utf8");
    expect((await readRequestIndex(logDir)).entries).toEqual({});
  });
});

describe("reconcileCommandRuns", () => {
  it("writes nothing when no session carries a command envelope", async () => {
    await writeSession(THREAD_ID, SESSION_ID, "just a plain question", "- decided: hi");
    expect(await reconcileCommandRuns(logDir, commandsDir)).toMatchObject({ written: 0, runs: 0 });
  });

  it("distils a run, placing its turns against the steps their artifacts anchor", async () => {
    await writeSession(
      THREAD_ID,
      SESSION_ID,
      ROOT,
      [
        "- decided: starting",
        "- Bash(command=my-command-tools worktree begin --branch feat/x)",
        "- Edit(file_path=/repo/a.ts)",
        "- Bash(command=my-command-tools verify)",
        "- done: shipped it",
      ].join("\n"),
    );
    await writeCapture({ iso: "2026-07-15T14:00:30.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 1 });
    await writeCapture({ iso: "2026-07-15T14:01:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 3 });
    await writeCapture({ iso: "2026-07-15T14:02:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 9 });

    const result = await reconcileCommandRuns(logDir, commandsDir, new Date("2026-07-15T18:00:00.000Z"));
    expect(result).toMatchObject({ written: 1, runs: 1, requestsRead: 3, capped: false });

    const [run] = await readCommandRuns(logDir);
    expect(run!.command).toBe("task");
    expect(run!.args).toBe("add a commands page");
    expect(run!.threadIds).toEqual([THREAD_ID]);
    expect(run!.steps.map((s) => s.id)).toEqual(["1", "2"]);
    expect(run!.commandHash).toMatch(/^[0-9a-f]{16}$/);
    expect(run!.totals.turns).toBe(3);
    expect(run!.totals.tokens.realInput).toBe(3000);
    expect(run!.totals.cost).toBeGreaterThan(0);
    expect(run!.totals.toolCalls).toBe(3);
    // The last declared step was reached and the transcript said `- done:`.
    expect(run!.reachedEnd).toBe(true);
    expect(run!.outcome).toBe("completed");
    // The opening request predates every anchor, so it lands in the unattributed gutter
    // rather than being charged to step 1 by proximity; the next sits on the
    // `worktree begin` anchor, and the last is past `verify`.
    expect(run!.turns.map((t) => t.step)).toEqual([null, "1", "2"]);
    expect(run!.meta.turnsUnmapped).toBe(1);
    expect(run!.turns[0]!.systemBytes).toBe(900);
    expect(run!.turns[0]!.messageCount).toBeGreaterThan(0);
  });

  it("strips the command envelope off the stored prompt", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- done: ok");
    await reconcileCommandRuns(logDir, commandsDir);
    const [run] = await readCommandRuns(logDir);
    expect(run!.prompt).not.toContain("<command-name>");
    expect(run!.prompt).toContain("add a commands page");
  });

  it("is idempotent: a second pass rewrites nothing and reopens no bodies", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- Bash(command=my-command-tools verify)\n- done: ok");
    await writeCapture({ iso: "2026-07-15T14:01:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 2 });

    const now = new Date("2026-07-15T18:00:00.000Z");
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 1, requestsRead: 1 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 0, requestsRead: 0 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 0, requestsRead: 0 });
    expect(await readCommandRuns(logDir)).toHaveLength(1);
  });

  it("rewrites the record as the run grows, so the page can follow it live", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- decided: starting");
    await writeCapture({ iso: "2026-07-15T14:01:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    const now = new Date("2026-07-15T18:00:00.000Z");
    await reconcileCommandRuns(logDir, commandsDir, now);
    expect((await readCommandRuns(logDir))[0]!.totals.turns).toBe(1);

    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- decided: starting\n- Bash(command=my-command-tools verify)");
    await writeCapture({ iso: "2026-07-15T14:03:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 6 });
    expect(await reconcileCommandRuns(logDir, commandsDir, now)).toMatchObject({ written: 1, requestsRead: 1 });
    expect((await readCommandRuns(logDir))[0]!.totals.turns).toBe(2);
  });

  // Sidecars are archived and then pruned. A turn's tokens must survive that, because
  // the record becomes the only evidence they were ever spent.
  it("keeps turns whose captured requests have since aged out", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- done: ok");
    await writeCapture({ iso: "2026-07-15T14:01:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    const now = new Date("2026-07-15T18:00:00.000Z");
    await reconcileCommandRuns(logDir, commandsDir, now);

    const { rm } = await import("node:fs/promises");
    const stem = stemFor("2026-07-15T14:01:00.000Z");
    await rm(path.join(logDir, `${stem}.audit.json`));
    await rm(path.join(logDir, `${stem}.request.txt`));

    await reconcileCommandRuns(logDir, commandsDir, now);
    const [run] = await readCommandRuns(logDir);
    expect(run!.totals.turns).toBe(1);
    expect(run!.totals.tokens.realInput).toBe(1000);
    expect(run!.model).toBe("claude-opus-5");
  });

  it("rolls a subagent's turns up into the run that spawned it", async () => {
    const subRoot = "go and research the thing";
    const subThread = threadIdFor(SESSION_ID, subRoot);
    await writeSession(
      THREAD_ID,
      SESSION_ID,
      ROOT,
      ["- Bash(command=my-command-tools verify)", `- Agent(subagent_type=Explore, threadId=${subThread})`, "- done: ok"].join(
        "\n",
      ),
    );
    await writeSession(subThread, SESSION_ID, subRoot, "- decided: looking");
    await writeCapture({ iso: "2026-07-15T14:01:00.000Z", sessionId: SESSION_ID, root: ROOT, nodes: 2 });
    await writeCapture({ iso: "2026-07-15T14:02:00.000Z", sessionId: SESSION_ID, root: subRoot, nodes: 2 });

    await reconcileCommandRuns(logDir, commandsDir, new Date("2026-07-15T18:00:00.000Z"));
    const run = (await readCommandRuns(logDir)).find((r) => r.threadId === THREAD_ID)!;
    expect(run.threadIds).toContain(subThread);
    expect(run.totals.turns).toBe(2);
    // The delegated turn is charged to the step that chose to delegate.
    expect(run.turns.find((t) => t.threadId === subThread)!.step).toBe("2");
  });

  it("still renders a run whose command has been uninstalled, against the steps it ran under", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- Bash(command=my-command-tools verify)\n- done: ok");
    await reconcileCommandRuns(logDir, commandsDir, new Date("2026-07-15T18:00:00.000Z"));

    const gone = await mkdtemp(path.join(tmpdir(), "commands-gone-"));
    await reconcileCommandRuns(logDir, gone, new Date("2026-07-15T18:00:00.000Z"));
    const [run] = await readCommandRuns(logDir);
    expect(run!.steps.map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("records a run with no captured requests rather than dropping it", async () => {
    await writeSession(THREAD_ID, SESSION_ID, ROOT, "- decided: started, then the logs aged out");
    expect(await reconcileCommandRuns(logDir, commandsDir)).toMatchObject({ written: 1 });
    const [run] = await readCommandRuns(logDir);
    expect(run!.turns).toEqual([]);
    expect(run!.totals.turns).toBe(0);
    expect(run!.totals.tokens.realInput).toBe(0);
  });
});
