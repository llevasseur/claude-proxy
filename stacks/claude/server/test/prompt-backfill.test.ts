import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type AuditSidecar, isAuditSidecar, outlineWirePrompt } from '@agent-proxy/claude-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../../proxy/json.ts';
import { backfillPromptIdentity, collectBackfillTargets } from '../src/prompt-backfill.js';
import { hashWirePrompt, readStoredPrompt, readStoredPrompts, writeStoredPrompt } from '../src/prompt-store.js';

const dirs: string[] = [];

async function tmpLogDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prompt-backfill-'));
  dirs.push(dir);
  return dir;
}

const block = (text: string) => ({ type: 'text', text });

function sidecar(overrides: JsonObject = {}) {
  return {
    timestamp: '2026-08-02T13:31:00.278Z',
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, realInput: 8 },
    request: { toolCount: 0, toolsBytes: 0, systemBytes: 100, totalBytes: 200 },
    tools: [],
    ...overrides,
  };
}

/** Write a sidecar and, unless `body` is null, the request body beside it. */
async function capture(dir: string, base: string, body: JsonValue, extra: JsonObject = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${base}.audit.json`), JSON.stringify(sidecar(extra), null, 2), 'utf8');
  if (body !== null) await writeFile(path.join(dir, `${base}.request.txt`), JSON.stringify(body), 'utf8');
}

async function readSidecar(dir: string, base: string): Promise<AuditSidecar> {
  return JSON.parse(await readFile(path.join(dir, `${base}.audit.json`), 'utf8'));
}

afterEach(async () => {
  // Directories are under the OS temp root; leaving them is harmless on CI.
  dirs.length = 0;
});

describe('collectBackfillTargets', () => {
  it('finds sidecars in the live directory and every archived day, archives first', async () => {
    const logDir = await tmpLogDir();
    await capture(logDir, '2026-08-03T10-00-00-000_anthropic', { system: 'live' });
    await capture(path.join(logDir, 'archive', '2026-08-01'), '2026-08-01T10-00-00-000_anthropic', { system: 'old' });
    await capture(path.join(logDir, 'archive', '2026-08-02'), '2026-08-02T10-00-00-000_anthropic', { system: 'mid' });
    await mkdir(path.join(logDir, 'archive', 'not-a-day'), { recursive: true });

    const targets = await collectBackfillTargets(logDir);
    expect(targets.map((t) => t.day)).toEqual(['2026-08-01', '2026-08-02', null]);
  });

  it('reports nothing for a log directory that does not exist', async () => {
    expect(await collectBackfillTargets(path.join(os.tmpdir(), 'definitely-not-here'))).toEqual([]);
  });
});

describe('backfillPromptIdentity', () => {
  it('dry run writes nothing but reports what it would do', async () => {
    const logDir = await tmpLogDir();
    const system = [block('# A\nhello')];
    await capture(logDir, '2026-08-02T10-00-00-000_anthropic', { system });

    const report = await backfillPromptIdentity(logDir, { apply: false });
    expect(report).toMatchObject({ scanned: 1, tagged: 1, promptsStored: 1, distinctPrompts: 1 });

    const after = await readSidecar(logDir, '2026-08-02T10-00-00-000_anthropic');
    expect(after.request.system).toBeUndefined();
    expect(await readStoredPrompts(logDir)).toEqual(new Map());
  });

  it('tags the sidecar and stores the outline once per distinct prompt', async () => {
    const logDir = await tmpLogDir();
    const system = [block('# A\nhello'), block('# B\nworld')];
    await capture(logDir, '2026-08-02T10-00-00-000_anthropic', { system });
    await capture(logDir, '2026-08-02T10-00-01-000_anthropic', { system });
    await capture(logDir, '2026-08-02T10-00-02-000_anthropic', { system: [block('# C\nother')] });

    const report = await backfillPromptIdentity(logDir, { apply: true });
    expect(report).toMatchObject({ scanned: 3, tagged: 3, promptsStored: 2, distinctPrompts: 2 });

    const hash = hashWirePrompt(system);
    const tagged = await readSidecar(logDir, '2026-08-02T10-00-00-000_anthropic');
    expect(tagged.request.system).toEqual({ hash, blocks: 2, sections: 2 });

    const stored = await readStoredPrompt(logDir, hash);
    expect(stored?.bytes).toBe(outlineWirePrompt(system).bytes);
    expect(stored?.sections.map((s) => s.heading)).toEqual(['A', 'B']);
    expect(stored?.firstSeen).toBe('2026-08-02T13:31:00.278Z');
  });

  it('leaves every other sidecar field exactly as it found it', async () => {
    const logDir = await tmpLogDir();
    await capture(
      logDir,
      '2026-08-02T10-00-00-000_anthropic',
      { system: [block('# A\na')] },
      {
        rateLimit: { 'anthropic-ratelimit-unified-remaining': '42' },
        session: {
          sessionId: 's1',
          app: null,
          userAgent: null,
          account: null,
          metadataSessionId: null,
          deviceId: null,
        },
      },
    );
    const before = await readSidecar(logDir, '2026-08-02T10-00-00-000_anthropic');

    await backfillPromptIdentity(logDir, { apply: true });
    const after = await readSidecar(logDir, '2026-08-02T10-00-00-000_anthropic');

    expect(isAuditSidecar(after)).toBe(true);
    const { system: _system, ...requestRest } = after.request;
    expect({ ...after, request: requestRest }).toEqual(before);
  });

  it('is idempotent — a second run tags nothing new', async () => {
    const logDir = await tmpLogDir();
    await capture(logDir, '2026-08-02T10-00-00-000_anthropic', { system: [block('# A\na')] });

    await backfillPromptIdentity(logDir, { apply: true });
    const second = await backfillPromptIdentity(logDir, { apply: true });
    expect(second).toMatchObject({ scanned: 1, tagged: 0, alreadyTagged: 1, promptsStored: 0, distinctPrompts: 1 });
  });

  it('counts an evicted body as such and leaves the sidecar alone', async () => {
    const logDir = await tmpLogDir();
    await capture(logDir, '2026-08-02T10-00-00-000_anthropic', null);

    const report = await backfillPromptIdentity(logDir, { apply: true });
    expect(report).toMatchObject({ scanned: 1, bodyMissing: 1, tagged: 0 });
    expect((await readSidecar(logDir, '2026-08-02T10-00-00-000_anthropic')).request.system).toBeUndefined();
  });

  it('separates a request with no system field from an unreadable body', async () => {
    const logDir = await tmpLogDir();
    await capture(logDir, '2026-08-02T10-00-00-000_anthropic', { model: 'claude-opus-5' });
    await capture(logDir, '2026-08-02T10-00-01-000_anthropic', null);
    await writeFile(path.join(logDir, '2026-08-02T10-00-01-000_anthropic.request.txt'), 'not json at all', 'utf8');

    const report = await backfillPromptIdentity(logDir, { apply: true });
    expect(report).toMatchObject({ noSystem: 1, unparseable: 1, tagged: 0 });
  });

  it('skips a malformed sidecar without failing the run', async () => {
    const logDir = await tmpLogDir();
    await writeFile(path.join(logDir, '2026-08-02T10-00-00-000_anthropic.audit.json'), '{"nope":true}', 'utf8');
    await capture(logDir, '2026-08-02T10-00-01-000_anthropic', { system: [block('# A\na')] });

    const report = await backfillPromptIdentity(logDir, { apply: true });
    expect(report).toMatchObject({ scanned: 2, unparseable: 1, tagged: 1, errors: [] });
  });

  it('reaches sidecars inside archived days', async () => {
    const logDir = await tmpLogDir();
    const dayDir = path.join(logDir, 'archive', '2026-07-20');
    await capture(dayDir, '2026-07-20T10-00-00-000_anthropic', { system: [block('# Old\nprompt')] });

    await backfillPromptIdentity(logDir, { apply: true });
    // `AuditSidecar.request.system` is optional — an untagged sidecar has none — so the
    // outline's presence is asserted rather than assumed.
    const { system } = (await readSidecar(dayDir, '2026-07-20T10-00-00-000_anthropic')).request;
    expect(system, 'the archived sidecar was tagged, so it carries a system outline').toBeDefined();
    expect(system?.blocks).toBe(1);
    // The store lives at the log root, not inside the archived day.
    expect((await readStoredPrompts(logDir)).size).toBe(1);
  });
});

describe('prompt store', () => {
  it('keeps the first record for a hash rather than overwriting it', async () => {
    const logDir = await tmpLogDir();
    const outline = outlineWirePrompt([block('# A\na')]);
    expect(await writeStoredPrompt(logDir, 'abc123ff', outline, '2026-08-01T00:00:00.000Z')).toBe(true);
    expect(await writeStoredPrompt(logDir, 'abc123ff', outline, '2026-08-02T00:00:00.000Z')).toBe(false);
    expect((await readStoredPrompt(logDir, 'abc123ff'))?.firstSeen).toBe('2026-08-01T00:00:00.000Z');
  });

  it('refuses a hash that could escape the store directory', async () => {
    const logDir = await tmpLogDir();
    expect(await readStoredPrompt(logDir, '../../etc/passwd')).toBeNull();
    expect(await readStoredPrompt(logDir, 'NOTHEX')).toBeNull();
  });

  it('reads an absent or malformed store as empty', async () => {
    const logDir = await tmpLogDir();
    expect(await readStoredPrompts(logDir)).toEqual(new Map());

    await mkdir(path.join(logDir, 'system-prompts'), { recursive: true });
    await writeFile(path.join(logDir, 'system-prompts', 'deadbeef.json'), '{ broken', 'utf8');
    expect(await readStoredPrompts(logDir)).toEqual(new Map());
  });

  it('filters to the hashes asked for', async () => {
    const logDir = await tmpLogDir();
    const outline = outlineWirePrompt([block('# A\na')]);
    await writeStoredPrompt(logDir, 'aaaaaaaa', outline, '2026-08-01T00:00:00.000Z');
    await writeStoredPrompt(logDir, 'bbbbbbbb', outline, '2026-08-01T00:00:00.000Z');
    expect([...(await readStoredPrompts(logDir, ['aaaaaaaa'])).keys()]).toEqual(['aaaaaaaa']);
  });
});
