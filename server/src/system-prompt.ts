import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The device system prompt — `~/.claude/CLAUDE.md`, the instructions Claude Code
 * loads into every session's system prompt on this machine. `CLAUDE_SYSTEM_PROMPT`
 * overrides the path.
 */
export function resolveSystemPromptPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SYSTEM_PROMPT
    ? path.resolve(env.CLAUDE_SYSTEM_PROMPT)
    : path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

/** Raw file state — text plus the metadata core needs to shape it. */
export interface SystemPromptFile {
  promptPath: string;
  exists: boolean;
  text: string;
  modified: string | null;
}

/**
 * Read the prompt file. An absent file is a legitimate state and reports as
 * `exists: false` with empty text, which is what the editor opens on. Any other
 * failure — unreadable, a directory — throws rather than passing for absent, which
 * would invite a save over a file this never managed to read.
 */
export async function readSystemPromptFile(promptPath: string): Promise<SystemPromptFile> {
  try {
    const [text, info] = await Promise.all([readFile(promptPath, 'utf8'), stat(promptPath)]);
    return { promptPath, exists: true, text, modified: info.mtime.toISOString() };
  } catch (cause) {
    // SAFETY: `readFile` and `stat` reject with a Node `ErrnoException` and nothing else,
    // so `code` is the field the runtime attached; anything without one is not `ENOENT`
    // and is rethrown, which is the branch that must never pass for absent.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw cause;
    return { promptPath, exists: false, text: '', modified: null };
  }
}

/** Where the pre-write copy of the prompt lands. */
export function systemPromptBackupPath(promptPath: string): string {
  return `${promptPath}.bak`;
}

export interface SystemPromptWrite extends SystemPromptFile {
  /** The `.bak` written first, or null when there was no previous file to copy. */
  backupPath: string | null;
}

/**
 * Replace the prompt file with `text`. The previous contents are copied to
 * `<path>.bak` first, so a bad save is recoverable outside the app, and the new
 * contents land via a temp file plus `rename`, so a crash mid-write can't leave a
 * half-written prompt for every later session to load.
 */
export async function writeSystemPromptFile(promptPath: string, text: string): Promise<SystemPromptWrite> {
  await mkdir(path.dirname(promptPath), { recursive: true });

  const backupPath = systemPromptBackupPath(promptPath);
  let backedUp = false;
  try {
    await copyFile(promptPath, backupPath);
    backedUp = true;
  } catch (cause) {
    // Nothing there yet is the first save; a backup that failed for any other reason
    // is not something to overwrite the original on top of.
    // SAFETY: `copyFile` rejects with a Node `ErrnoException`, so `code` is the errno the
    // runtime attached; a value carrying none reads as not-`ENOENT` and is rethrown.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw cause;
  }

  const temp = `${promptPath}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, promptPath);

  return { ...(await readSystemPromptFile(promptPath)), backupPath: backedUp ? backupPath : null };
}
