import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { outlineWirePrompt } from '@claude-proxy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSummary, buildToolSchema } from '../src/api.js';
import {
  classifierPromptHashes,
  clearClassifierCache,
  hashWirePrompt,
  writeStoredPrompt,
} from '../src/prompt-store.js';

/** Late enough in the reporting day that `today()` is unambiguous. */
const NOW = new Date('2026-08-03T20:00:00.000Z');
const DAY = '2026-08-03';

async function tmpLogDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'per-call-api-'));
}

interface Tool {
  name: string;
  bytes: number;
  estTokens: number;
}

/** One request's sidecar, plus the body it was sent with. */
async function request(
  logDir: string,
  opts: { seq: number; system: unknown; tools: Tool[]; sessionId?: string; body?: boolean },
): Promise<string> {
  await mkdir(logDir, { recursive: true });
  const outline = outlineWirePrompt(opts.system);
  const hash = hashWirePrompt(opts.system);
  const stamp = `${DAY}T${String(10 + Math.floor(opts.seq / 60)).padStart(2, '0')}-${String(opts.seq % 60).padStart(2, '0')}-00-000`;
  const toolsBytes = opts.tools.reduce((a, t) => a + t.bytes, 0);
  const base = {
    timestamp: `${DAY}T${String(14 + Math.floor(opts.seq / 60)).padStart(2, '0')}:${String(opts.seq % 60).padStart(2, '0')}:00.000Z`,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 200, cacheRead: 3_000, cacheCreation: 0, realInput: 3_100 },
    request: {
      toolCount: opts.tools.length,
      toolsBytes,
      systemBytes: outline.bytes,
      totalBytes: toolsBytes + outline.bytes,
      system: { hash, blocks: outline.blocks.length, sections: outline.sections.length },
    },
    tools: opts.tools,
  };
  // `session` is omitted entirely (not written as `undefined`) when no sessionId is
  // given, since a downstream reader keys off the key's presence.
  const sidecar = opts.sessionId ? { ...base, session: { sessionId: opts.sessionId } } : base;
  await writeFile(path.join(logDir, `${stamp}_anthropic.audit.json`), JSON.stringify(sidecar), 'utf8');
  if (opts.body !== false) {
    const body = {
      system: opts.system,
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: `does ${t.name}`,
        input_schema: { type: 'object', properties: {} },
      })),
    };
    await writeFile(path.join(logDir, `${stamp}_anthropic.request.txt`), JSON.stringify(body), 'utf8');
  }
  return hash;
}

const WORK_PROMPT = [{ type: 'text', text: '# You are Claude Code\nhelp with software engineering.' }];
const CLASSIFIER_PROMPT = [
  { type: 'text', text: '# HARD BLOCK\nnever do these.\n# SOFT BLOCK\nask first about these.' },
];
const TOOLS: Tool[] = [
  { name: 'Bash', bytes: 4_000, estTokens: 1_000 },
  { name: 'Read', bytes: 2_000, estTokens: 500 },
];

beforeEach(() => {
  clearClassifierCache();
});

describe('classifierPromptHashes', () => {
  it('recognises a stored outline carrying both block headings', async () => {
    const logDir = await tmpLogDir();
    const work = hashWirePrompt(WORK_PROMPT);
    const cls = hashWirePrompt(CLASSIFIER_PROMPT);
    await writeStoredPrompt(logDir, work, outlineWirePrompt(WORK_PROMPT), `${DAY}T14:00:00.000Z`);
    await writeStoredPrompt(logDir, cls, outlineWirePrompt(CLASSIFIER_PROMPT), `${DAY}T14:00:00.000Z`);

    const hashes = await classifierPromptHashes(logDir);
    expect(hashes.has(cls)).toBe(true);
    expect(hashes.has(work)).toBe(false);
    expect(hashes.size).toBe(1);
  });

  it('returns an empty set when nothing has been stored', async () => {
    expect((await classifierPromptHashes(await tmpLogDir())).size).toBe(0);
  });
});

describe('buildSummary perCall', () => {
  it('holds classifier traffic out of the headline mean', async () => {
    const logDir = await tmpLogDir();
    await request(logDir, { seq: 0, system: WORK_PROMPT, tools: TOOLS, sessionId: 's1' });
    await request(logDir, { seq: 1, system: WORK_PROMPT, tools: TOOLS, sessionId: 's1' });
    await request(logDir, { seq: 2, system: CLASSIFIER_PROMPT, tools: [], sessionId: 's1' });
    await writeStoredPrompt(
      logDir,
      hashWirePrompt(CLASSIFIER_PROMPT),
      outlineWirePrompt(CLASSIFIER_PROMPT),
      `${DAY}T14:00:00.000Z`,
    );

    const { digest } = await buildSummary(logDir, DAY, NOW);
    expect(digest.perCall.identified).toBe(true);
    expect(digest.perCall.work.requests).toBe(2);
    expect(digest.perCall.classifier.requests).toBe(1);
    expect(digest.perCall.all.requests).toBe(3);
    // The classifier ships no tools, so holding it out raises the fixed prefix.
    expect(digest.perCall.work.fixedPrefixTokens).toBeGreaterThan(digest.perCall.all.fixedPrefixTokens);
    expect(digest.perCall.work.callsPerSession).toBe(2);
  });

  it('counts everything as work when no outline identifies a classifier', async () => {
    const logDir = await tmpLogDir();
    await request(logDir, { seq: 0, system: WORK_PROMPT, tools: TOOLS, sessionId: 's1' });

    const { digest } = await buildSummary(logDir, DAY, NOW);
    expect(digest.perCall.identified).toBe(true);
    expect(digest.perCall.classifier.requests).toBe(0);
    expect(digest.perCall.work.requests).toBe(1);
  });
});

describe('buildToolSchema', () => {
  it('reads back one tool definition and its share of the window', async () => {
    const logDir = await tmpLogDir();
    await request(logDir, { seq: 0, system: WORK_PROMPT, tools: TOOLS });
    await request(logDir, { seq: 1, system: WORK_PROMPT, tools: TOOLS });

    const schema = await buildToolSchema(logDir, 'Bash', 7, NOW);
    expect(schema.name).toBe('Bash');
    expect(schema.requests).toBe(2);
    expect(schema.bytes).toBe(4_000);
    expect(schema.estTokens).toBe(1_000);
    // 4000 of 6000 tool bytes per request, both requests.
    expect(schema.shareOfToolBytes).toBeCloseTo(2 / 3, 10);
    expect(schema.file).not.toBeNull();
    expect(JSON.parse(schema.schema!)).toMatchObject({ name: 'Bash', description: 'does Bash' });
  });

  it('reports the size without the text once every body has aged out', async () => {
    const logDir = await tmpLogDir();
    await request(logDir, { seq: 0, system: WORK_PROMPT, tools: TOOLS, body: false });

    const schema = await buildToolSchema(logDir, 'Read', 7, NOW);
    expect(schema.bytes).toBe(2_000);
    expect(schema.schema).toBeNull();
    expect(schema.file).toBeNull();
    expect(schema.meta.candidates).toBe(1);
  });

  it('answers for a tool no request ever carried rather than throwing', async () => {
    const logDir = await tmpLogDir();
    await request(logDir, { seq: 0, system: WORK_PROMPT, tools: TOOLS });

    const schema = await buildToolSchema(logDir, 'Nope', 7, NOW);
    expect(schema.requests).toBe(0);
    expect(schema.bytes).toBe(0);
    expect(schema.shareOfToolBytes).toBe(0);
    expect(schema.schema).toBeNull();
  });
});
