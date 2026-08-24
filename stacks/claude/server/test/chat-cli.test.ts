import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../proxy/json.ts';
import {
  type CliLiveEvent,
  CliLiveReader,
  type CliRunHandle,
  cliArgs,
  cliEnv,
  cliSettings,
  decodeCliStream,
  resolveAgentCwd,
  runCliTurn,
} from '../src/chat-cli.js';

/** The fields every `cliArgs` call needs; each test overrides what it cares about. */
const base = {
  baseUrl: 'http://127.0.0.1:8787',
  model: 'claude-opus-5',
  system: 'be brief',
  sessionId: '11111111-2222-3333-4444-555555555555',
  resume: false,
};

/** The value passed to a flag, so assertions don't depend on argv ordering. */
const flagValue = (args: string[], flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

describe('cliSettings', () => {
  it('carries the base url so a device settings.json cannot redirect the turn', () => {
    expect(cliSettings('http://127.0.0.1:8787')).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } });
  });

  it("keeps an alias's own overrides alongside it", () => {
    expect(cliSettings('http://proxy', { enableWorkflows: true })).toEqual({
      enableWorkflows: true,
      env: { ANTHROPIC_BASE_URL: 'http://proxy' },
    });
  });

  it('lets the base url win over one the alias injects', () => {
    const settings = cliSettings('http://proxy', { env: { ANTHROPIC_BASE_URL: 'http://elsewhere', FOO: '1' } });
    expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: 'http://proxy', FOO: '1' });
  });
});

describe('cliArgs — chat mode', () => {
  const args = cliArgs({ ...base, mode: 'chat' });

  it('locks the child down', () => {
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(flagValue(args, '--tools')).toBe('');
  });

  it('replaces the system prompt rather than appending', () => {
    expect(flagValue(args, '--system-prompt')).toBe('be brief');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('opens the session id it was given', () => {
    expect(flagValue(args, '--session-id')).toBe(base.sessionId);
    expect(args).not.toContain('--resume');
  });
});

describe('cliArgs — agent mode', () => {
  const args = cliArgs({ ...base, mode: 'agent', permissionMode: 'acceptEdits' });

  it('drops the three flags that would defeat parity', () => {
    expect(args).not.toContain('--safe-mode');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--tools');
  });

  it('appends its system prompt so Claude Code keeps its own', () => {
    expect(flagValue(args, '--append-system-prompt')).toBe('be brief');
    expect(args).not.toContain('--system-prompt');
  });

  it('gives the headless child a standing answer to permission prompts', () => {
    expect(flagValue(args, '--permission-mode')).toBe('acceptEdits');
  });

  it("omits --setting-sources so the CLI's default set loads", () => {
    expect(args).not.toContain('--setting-sources');
  });

  it('replays the tools the device alias withholds', () => {
    const withheld = cliArgs({
      ...base,
      mode: 'agent',
      agentFlags: { disallowedTools: ['Monitor', 'DesignSync'], settingSources: null, settingsOverrides: null },
    });
    expect(withheld.slice(withheld.indexOf('--disallowed-tools'), withheld.indexOf('--disallowed-tools') + 3)).toEqual([
      '--disallowed-tools',
      'Monitor',
      'DesignSync',
    ]);
  });

  it("passes the alias's setting sources when it names them", () => {
    const scoped = cliArgs({
      ...base,
      mode: 'agent',
      agentFlags: { disallowedTools: [], settingSources: ['project', 'local'], settingsOverrides: null },
    });
    expect(flagValue(scoped, '--setting-sources')).toBe('project,local');
  });

  it('resumes instead of opening once a turn has been sent', () => {
    const next = cliArgs({ ...base, mode: 'agent', resume: true });
    expect(flagValue(next, '--resume')).toBe(base.sessionId);
    expect(next).not.toContain('--session-id');
  });
});

describe('cliEnv', () => {
  it('points the child at the proxy and strips both credentials', () => {
    const env = cliEnv('http://127.0.0.1:8787', {
      ANTHROPIC_API_KEY: 'sk-should-not-survive',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      PATH: '/usr/bin',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('resolveAgentCwd', () => {
  it('is the checkout of the running server, the same root logs/ resolves against', () => {
    const cwd = resolveAgentCwd();
    expect(path.isAbsolute(cwd)).toBe(true);
    // server/src/chat-cli.ts → ../.. is the repo root, which holds server/.
    expect(path.basename(path.join(cwd, 'server'))).toBe('server');
  });
});

describe('decodeCliStream', () => {
  const line = (o: JsonValue) => `${JSON.stringify(o)}\n`;

  it('prefers the terminal result and reads usage off it', () => {
    const raw =
      line({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial' }] } }) +
      line({ type: 'result', result: 'final', usage: { input_tokens: 10, output_tokens: 3 } });
    const out = decodeCliStream(raw);
    expect(out.text).toBe('final');
    expect(out.sessionId).toBe('s1');
    expect(out.usage).toMatchObject({ input: 10, output: 3 });
  });

  it('reads the permission mode the child reports it started under', () => {
    const raw =
      line({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'bypassPermissions' }) +
      line({ type: 'result', result: 'done' });
    expect(decodeCliStream(raw).permissionMode).toBe('bypassPermissions');
  });

  it('leaves the permission mode null when the child never announced one', () => {
    expect(decodeCliStream(line({ type: 'result', result: 'done' })).permissionMode).toBeNull();
  });

  it('falls back to assistant text when a run ends without a result', () => {
    const raw = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'only this' }] } });
    expect(decodeCliStream(raw).text).toBe('only this');
  });

  it('collects the tools an agent turn ran, in order', () => {
    const raw =
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool_use', id: 't1', name: 'Read' },
            { type: 'tool_use', id: 't2', name: 'Bash' },
          ],
        },
      }) + line({ type: 'result', result: 'done' });
    expect(decodeCliStream(raw).tools).toEqual([
      { name: 'Read', failed: false },
      { name: 'Bash', failed: false },
    ]);
  });

  it('marks a tool failed from its tool_result', () => {
    const raw =
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }) +
      line({ type: 'result', result: 'done' });
    expect(decodeCliStream(raw).tools).toEqual([{ name: 'Bash', failed: true }]);
  });

  it("carries the tool_result's own text, so a denial reads as one", () => {
    const raw =
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }) +
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: [
                { type: 'text', text: "Claude requested permissions to use Bash, but you haven't granted it yet." },
              ],
            },
          ],
        },
      }) +
      line({ type: 'result', result: 'done' });
    expect(decodeCliStream(raw).tools[0]?.error).toMatch(/requested permissions to use Bash/);
  });

  it("truncates a long tool_result rather than returning a whole command's output", () => {
    const raw =
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } }) +
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x'.repeat(2000) }] },
      });
    const error = decodeCliStream(raw).tools[0]?.error ?? '';
    expect(error.length).toBeLessThan(500);
    expect(error.endsWith('…')).toBe(true);
  });

  it('reports a completed run as not interrupted', () => {
    expect(decodeCliStream(line({ type: 'result', result: 'hi' })).interrupted).toBeNull();
  });

  it('keeps the partial text and tools of a killed run instead of throwing', () => {
    const raw =
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'got this far' }] } }) +
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } }) +
      line({ type: 'result', is_error: true, subtype: 'error_during_execution' });
    expect(() => decodeCliStream(raw)).toThrow(/error_during_execution/);
    const partial = decodeCliStream(raw, { partial: true });
    expect(partial.text).toBe('got this far');
    expect(partial.tools).toEqual([{ name: 'Read', failed: false }]);
  });

  it('reports no tools for a chat turn', () => {
    expect(decodeCliStream(line({ type: 'result', result: 'hi' })).tools).toEqual([]);
  });

  it('ignores non-JSON chatter', () => {
    const raw = `warning: something\n${line({ type: 'result', result: 'ok' })}`;
    expect(decodeCliStream(raw).text).toBe('ok');
  });

  it('throws when the run reports an error', () => {
    const raw = line({ type: 'result', is_error: true, result: 'boom' });
    expect(() => decodeCliStream(raw)).toThrow(/boom/);
  });
});

// --- runCliTurn, against a stand-in for `claude` -----------------------------
//
// The stop path needs a real process: it has to reach the tools an agent turn started,
// not just the CLI, and keep the output the run had already produced.

const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cli-test-'));
afterAll(() => fs.rmSync(FIXTURES, { recursive: true, force: true }));

/** Prints one stream-json line, starts a child in its own group, then hangs. */
function fakeCli(name: string) {
  const cliPath = path.join(FIXTURES, name);
  const childPidFile = path.join(FIXTURES, `${name}.child`);
  fs.writeFileSync(
    cliPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const line = ${JSON.stringify(
        JSON.stringify({
          type: 'assistant',
          session_id: 's1',
          message: { content: [{ type: 'text', text: 'partial' }] },
        }),
      )};`,
      'process.stdout.write(line + "\\n", () => {',
      '  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      `  fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
      '});',
      'setTimeout(() => {}, 60000);',
      '',
    ].join('\n'),
  );
  fs.chmodSync(cliPath, 0o755);
  return { cliPath, childPidFile };
}

const turnInput = (cliPath: string) => ({
  cliPath,
  cwd: FIXTURES,
  baseUrl: 'http://127.0.0.1:8787',
  mode: 'agent' as const,
  model: 'claude-opus-5',
  system: 'be brief',
  sessionId: '11111111-2222-3333-4444-555555555555',
  resume: false,
  prompt: 'hello',
  idleTimeoutMs: 30_000,
  maxTurnMs: 120_000,
});

/** A stand-in that keeps emitting: one stream-json line every `everyMs`, forever. */
function chattyCli(name: string, everyMs: number): string {
  const cliPath = path.join(FIXTURES, name);
  const line = JSON.stringify({
    type: 'assistant',
    session_id: 's1',
    message: { content: [{ type: 'text', text: 'partial' }] },
  });
  fs.writeFileSync(
    cliPath,
    [
      '#!/usr/bin/env node',
      `const line = ${JSON.stringify(line)} + "\\n";`,
      'process.stdout.write(line);',
      `setInterval(() => process.stdout.write(line), ${everyMs});`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

/**
 * Run a stand-in once and throw the run away, so the measured run is not the first exec.
 *
 * The idle clock arms at spawn, so the first window has to cover a fresh fixture's first
 * exec, which is far pricier than a later one. Measured on the development machine, 25
 * samples per condition, spawn to first stdout byte:
 *
 * | fixture exec        | median | p90    | max    |
 * |---------------------|--------|--------|--------|
 * | fresh file, idle    | 194 ms | 476 ms | 975 ms |
 * | fresh file, loaded  | 209 ms | 231 ms | 442 ms |
 * | re-exec, idle       |  28 ms |  31 ms | 323 ms |
 * | re-exec, loaded     |  47 ms |  52 ms | 227 ms |
 *
 * That first-exec tail is what ended a run at 602 ms under a 600 ms window. Paying it
 * here leaves the measured run a ~30 ms startup.
 */
async function warmUp(cliPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const probe = spawn(cliPath, [], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const finish = (): void => {
      try {
        if (probe.pid) process.kill(-probe.pid, 'SIGKILL');
      } catch {
        /* already gone, or never had a group */
      }
      resolve();
    };
    probe.stdout.once('data', finish);
    probe.once('error', () => resolve());
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until `check` holds or the deadline passes; returns whether it held. */
async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe.skipIf(process.platform === 'win32')('runCliTurn — ending a run early', () => {
  it('stops the whole process group and returns what the run had reached', async () => {
    const { cliPath, childPidFile } = fakeCli('fake-claude-stop');
    // `onStart` fires from inside `runCliTurn`, where the checker cannot follow — so the
    // run is collected rather than assigned to a nullable local.
    const started: CliRunHandle[] = [];
    const turn = runCliTurn({ ...turnInput(cliPath), onStart: (run) => started.push(run) });

    expect(await until(() => fs.existsSync(childPidFile))).toBe(true);
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    const handle = started[0];
    if (!handle) throw new Error('onStart never fired, so the spawned run was never reported');
    handle.stop();

    const result = await turn;
    expect(result.interrupted).toBe('stopped');
    expect(result.text).toBe('partial'); // the prefix that arrived, not discarded
    expect(result.sessionId).toBe('s1');
    // The tool the CLI itself started goes with it, rather than being orphaned.
    expect(await until(() => !alive(childPid))).toBe(true);
  });

  it('ends a run that has gone silent, keeping what it had already said', async () => {
    const { cliPath } = fakeCli('fake-claude-idle'); // one line, then hangs
    // The idle clock arms at spawn, so this window must cover the child's whole startup.
    // 2 s is roughly twice the worst first-exec startup measured for these fixtures — see
    // warmUp for the numbers.
    const result = await runCliTurn({ ...turnInput(cliPath), idleTimeoutMs: 2_000 });
    expect(result.interrupted).toBe('timeout');
    expect(result.text).toBe('partial'); // reported, not thrown away
  });

  it('lets a still-producing run outlive the idle window many times over', async () => {
    const EVERY_MS = 50; // the stand-in's emission interval
    const IDLE_MS = 1_000; // the silence clock this run has to keep re-arming
    const CEILING_MS = 3_000; // the limit that should be what actually ends it

    const cliPath = chattyCli('fake-claude-chatty', EVERY_MS);
    await warmUp(cliPath); // see warmUp: the first exec is the expensive one

    // Records when output actually arrived, not how long the call took. `onEvent` is a
    // pure watcher — the result is decoded from the whole stream either way.
    const arrivals: number[] = [];
    const result = await runCliTurn({
      ...turnInput(cliPath),
      idleTimeoutMs: IDLE_MS,
      maxTurnMs: CEILING_MS,
      onEvent: () => arrivals.push(Date.now()),
    });
    const ended = Date.now();

    // Asserted first and on the timer, not a duration, so a failure names which clock
    // fired ("expected 'timeout' to be 'limit'") instead of a bare elapsed number.
    expect(result.interrupted).toBe('limit');

    const first = arrivals[0];
    const last = arrivals[arrivals.length - 1];
    if (first === undefined || last === undefined) throw new Error('the chatty stand-in never produced a line');

    // The longest silence anywhere in the run — between two lines, or between the last
    // line and the end — stayed under the idle window: the run was never idle enough to end.
    const gaps: number[] = [];
    let previous = first;
    for (const at of arrivals.slice(1)) {
      gaps.push(at - previous);
      previous = at;
    }
    gaps.push(ended - last);
    expect(Math.max(...gaps)).toBeLessThan(IDLE_MS);

    // Stayed alive for several idle windows' worth of streaming, measured from the first
    // line rather than the call, so the child's own startup is excluded.
    expect(ended - first).toBeGreaterThan(IDLE_MS * 2);
    expect(arrivals.length).toBeGreaterThan(10); // genuinely streaming, not one lucky line

    expect(result.text).toMatch(/^(partial)+$/);
  });

  it('still fails loudly when the cli is not there at all', async () => {
    await expect(runCliTurn(turnInput(path.join(FIXTURES, 'nope')))).rejects.toThrow(/could not start/);
  });

  // The watch reads each chunk once, so a line arriving in pieces has to be held until
  // it is whole — the announcement is worth nothing if it only survives a tidy write.
  it("announces the child's permission mode even when the init line arrives in pieces", async () => {
    const cliPath = path.join(FIXTURES, 'fake-claude-init-split');
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      permissionMode: 'bypassPermissions',
    });
    const half = Math.floor(init.length / 2);
    fs.writeFileSync(
      cliPath,
      [
        '#!/usr/bin/env node',
        `process.stdout.write(${JSON.stringify(init.slice(0, half))});`,
        `setTimeout(() => process.stdout.write(${JSON.stringify(init.slice(half))} + "\\n"), 40);`,
        `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', result: 'done' }))} + "\\n"), 80);`,
        '',
      ].join('\n'),
    );
    fs.chmodSync(cliPath, 0o755);

    const seen: (string | null)[] = [];
    const result = await runCliTurn({ ...turnInput(cliPath), onInit: (info) => seen.push(info.permissionMode) });
    expect(seen).toEqual(['bypassPermissions']); // once, not per chunk
    expect(result.permissionMode).toBe('bypassPermissions');
  });
});

describe('CliLiveReader', () => {
  const line = (o: JsonValue) => `${JSON.stringify(o)}\n`;

  /** Feed a whole stream in one chunk and collect what was reported. */
  const readAll = (raw: string, split = raw.length): CliLiveEvent[] => {
    const seen: CliLiveEvent[] = [];
    const reader = new CliLiveReader((e) => seen.push(e));
    const buf = Buffer.from(raw, 'utf8');
    for (let i = 0; i < buf.length; i += split) reader.write(buf.subarray(i, i + split));
    return seen;
  };

  it('reports text and tools interleaved in the order the turn produced them', () => {
    const raw =
      line({ type: 'system', subtype: 'init', permissionMode: 'plan' }) +
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'looking' },
            { type: 'tool_use', id: 't1', name: 'Read' },
          ],
        },
      }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }) +
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash' }] },
      }) +
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'exit 1\nmore' }],
        },
      }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });

    expect(readAll(raw)).toEqual([
      { kind: 'init', permissionMode: 'plan' },
      { kind: 'text', text: 'looking' },
      { kind: 'tool', index: 0, name: 'Read' },
      { kind: 'tool-result', index: 0, failed: false },
      { kind: 'tool', index: 1, name: 'Bash' },
      { kind: 'tool-result', index: 1, failed: true, error: 'exit 1\nmore' },
      { kind: 'text', text: 'done' },
    ]);
  });

  it('indexes tools the way the finished decode does, so a live chip is the summary chip', () => {
    const raw =
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Read' },
            { type: 'tool_use', id: 't2', name: 'Bash' },
          ],
        },
      }) + line({ type: 'result', result: 'done' });
    const live = readAll(raw).filter((e) => e.kind === 'tool');
    expect(live.map((e) => (e.kind === 'tool' ? e.name : ''))).toEqual(decodeCliStream(raw).tools.map((t) => t.name));
    expect(live.map((e) => (e.kind === 'tool' ? e.index : -1))).toEqual([0, 1]);
  });

  it('reads the same events however the chunk boundaries fall, including mid-character', () => {
    const raw =
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'héllo — wörld' }] } }) +
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep' }] } });
    const whole = readAll(raw);
    expect(readAll(raw, 1)).toEqual(whole);
    expect(readAll(raw, 7)).toEqual(whole);
  });

  it('holds a half-written trailing line rather than reporting it', () => {
    const seen: CliLiveEvent[] = [];
    const reader = new CliLiveReader((e) => seen.push(e));
    reader.write(Buffer.from(`{"type":"system","subtype":"init","permissionMode":"pl`));
    expect(seen).toEqual([]);
    reader.write(Buffer.from(`an"}\n`));
    expect(seen).toEqual([{ kind: 'init', permissionMode: 'plan' }]);
  });

  it('ignores non-JSON chatter and a tool_result for a call it never saw', () => {
    const raw =
      'warning: something\n' +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope' }] } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    expect(readAll(raw)).toEqual([{ kind: 'text', text: 'ok' }]);
  });
});
