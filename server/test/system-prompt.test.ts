import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildSystemPromptUpdate } from '../src/api.js';
import { resolveSystemPromptPath, systemPromptBackupPath } from '../src/system-prompt.js';

let dir: string;
let promptPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'system-prompt-'));
  promptPath = path.join(dir, 'CLAUDE.md');
});

describe('resolveSystemPromptPath', () => {
  it("defaults to the device's `~/.claude/CLAUDE.md`", () => {
    // SAFETY: resolveSystemPromptPath only reads `env.CLAUDE_SYSTEM_PROMPT`; this test wants
    // that key absent, and `{}` has every other `NodeJS.ProcessEnv` key as optional already.
    expect(resolveSystemPromptPath({} as NodeJS.ProcessEnv)).toMatch(/[/\\]\.claude[/\\]CLAUDE\.md$/);
  });

  it('takes an override, resolved to absolute', () => {
    // SAFETY: same as above — only `CLAUDE_SYSTEM_PROMPT` is read, and this test sets exactly
    // that one key to the temp path created in beforeEach.
    expect(resolveSystemPromptPath({ CLAUDE_SYSTEM_PROMPT: promptPath } as NodeJS.ProcessEnv)).toBe(promptPath);
  });
});

describe('buildSystemPrompt', () => {
  it("reports an absent file as empty rather than erroring — that's the first-save state", async () => {
    const res = await buildSystemPrompt(promptPath);

    expect(res.prompt).toMatchObject({ path: promptPath, exists: false, text: '', bytes: 0, modified: null });
    expect(res.maxBytes).toBeGreaterThan(0);
  });

  it('reads the file with its outline and size', async () => {
    await writeFile(promptPath, '# Device rules\n\nBe brief.\n', 'utf8');

    const { prompt } = await buildSystemPrompt(promptPath);

    expect(prompt.exists).toBe(true);
    expect(prompt.text).toBe('# Device rules\n\nBe brief.\n');
    expect(prompt.sections.map((s) => s.heading)).toEqual(['Device rules']);
    expect(prompt.modified).not.toBeNull();
  });

  it('fails loudly when the path is unreadable, rather than passing for absent', async () => {
    await expect(buildSystemPrompt(dir)).rejects.toThrow();
  });
});

describe('buildSystemPromptUpdate', () => {
  it('creates the file on the first save, with no backup to keep', async () => {
    const res = await buildSystemPromptUpdate(promptPath, '# New rules\n');

    expect(res.backupPath).toBeNull();
    expect(await readFile(promptPath, 'utf8')).toBe('# New rules\n');
    expect(res.prompt.exists).toBe(true);
  });

  it('keeps the previous contents in a `.bak` on every later save', async () => {
    await buildSystemPromptUpdate(promptPath, 'first\n');
    const res = await buildSystemPromptUpdate(promptPath, 'second\n');

    expect(res.backupPath).toBe(systemPromptBackupPath(promptPath));
    expect(await readFile(res.backupPath!, 'utf8')).toBe('first\n');
    expect(await readFile(promptPath, 'utf8')).toBe('second\n');
  });

  it('normalizes what it writes, and answers with a fresh read of it', async () => {
    const res = await buildSystemPromptUpdate(promptPath, '# Rules\r\n\r\nBe brief.\r\n\n\n');

    expect(await readFile(promptPath, 'utf8')).toBe('# Rules\n\nBe brief.\n');
    expect(res.prompt.text).toBe('# Rules\n\nBe brief.\n');
    expect(res.prompt.bytes).toBe(19);
  });

  it('writes an empty prompt when that is the edit, rather than deleting the file', async () => {
    await buildSystemPromptUpdate(promptPath, '# Rules\n');
    const res = await buildSystemPromptUpdate(promptPath, '   ');

    expect(await readFile(promptPath, 'utf8')).toBe('');
    expect(res.prompt).toMatchObject({ exists: true, text: '', bytes: 0, sections: [] });
  });

  it('refuses an invalid edit before touching the file', async () => {
    await buildSystemPromptUpdate(promptPath, '# Keep me\n');

    await expect(buildSystemPromptUpdate(promptPath, 42)).rejects.toThrow(/must be a string/);
    expect(await readFile(promptPath, 'utf8')).toBe('# Keep me\n');
  });

  it('creates the parent directory when the whole `.claude` home is missing', async () => {
    const nested = path.join(dir, 'fresh-home', 'CLAUDE.md');

    await buildSystemPromptUpdate(nested, '# Rules\n');

    expect(await readFile(nested, 'utf8')).toBe('# Rules\n');
  });

  it('writes when the caller sends no expected mtime at all', async () => {
    await buildSystemPromptUpdate(promptPath, '# First\n');

    await buildSystemPromptUpdate(promptPath, '# Second\n');

    expect(await readFile(promptPath, 'utf8')).toBe('# Second\n');
  });

  it('writes when the file still carries the mtime the caller read', async () => {
    await buildSystemPromptUpdate(promptPath, '# First\n');
    const { prompt } = await buildSystemPrompt(promptPath);

    await buildSystemPromptUpdate(promptPath, '# Second\n', prompt.modified);

    expect(await readFile(promptPath, 'utf8')).toBe('# Second\n');
  });

  it('refuses a stale save, leaving the concurrent edit on disk', async () => {
    await buildSystemPromptUpdate(promptPath, '# Written by someone else\n');

    await expect(buildSystemPromptUpdate(promptPath, '# Mine\n', '2020-01-01T00:00:00.000Z')).rejects.toThrow(
      /changed on disk/,
    );
    expect(await readFile(promptPath, 'utf8')).toBe('# Written by someone else\n');
  });

  it('treats a null expected mtime as "there was no file", so the first save goes through', async () => {
    await buildSystemPromptUpdate(promptPath, '# Rules\n', null);

    expect(await readFile(promptPath, 'utf8')).toBe('# Rules\n');
  });

  it('refuses that same first save once a file has appeared underneath it', async () => {
    await writeFile(promptPath, '# Someone got there first\n', 'utf8');

    await expect(buildSystemPromptUpdate(promptPath, '# Rules\n', null)).rejects.toThrow(/changed on disk/);
    expect(await readFile(promptPath, 'utf8')).toBe('# Someone got there first\n');
  });

  it('checks the body before the mtime, so an invalid edit still fails on the body', async () => {
    await buildSystemPromptUpdate(promptPath, '# Keep me\n');

    await expect(buildSystemPromptUpdate(promptPath, 42, '2020-01-01T00:00:00.000Z')).rejects.toThrow(
      /must be a string/,
    );
    expect(await readFile(promptPath, 'utf8')).toBe('# Keep me\n');
  });
});
