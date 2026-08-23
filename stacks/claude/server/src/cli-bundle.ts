import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type CliFunctionEntry, resolveCliCatalogue } from '@agent-proxy/claude-core';

/**
 * The installed Claude Code bundle, as read-only input.
 *
 * Nothing here writes — the versions directory belongs to the installer and is only
 * ever opened for reading. The bundle is a single ~270 MB compiled executable with a
 * region of minified JS inside it: it is read once per version, resolved in one pass,
 * and only the resolved offsets are kept. A detail view re-reads its function by a
 * ranged read at the cached offset.
 */

/** Where the installer keeps versioned bundles. */
function versionsDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CLI_VERSIONS ?? path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
}

/**
 * The bundle this machine actually runs. `~/.local/bin/claude` symlinks the active
 * version; the highest-sorted entry in the versions directory covers an install with
 * no launcher symlink. `CLAUDE_CLI_BUNDLE` overrides both.
 */
export async function resolveCliBundlePath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.CLAUDE_CLI_BUNDLE) return path.resolve(env.CLAUDE_CLI_BUNDLE);

  const dir = versionsDir(env);
  try {
    const target = await realpath(path.join(os.homedir(), '.local', 'bin', 'claude'));
    // Only trust the symlink when it lands in the versions directory; a launcher
    // shim pointing elsewhere is not a bundle to parse.
    if (path.dirname(target) === dir) return target;
  } catch {
    // No launcher symlink — fall through to the directory listing.
  }

  try {
    const entries = await readdir(dir);
    const versions = entries.filter((e) => /^\d/.test(e)).sort(compareVersions);
    const newest = versions[versions.length - 1];
    return newest === undefined ? null : path.join(dir, newest);
  } catch {
    return null;
  }
}

/** Order two dotted version strings numerically, so 2.1.9 sorts below 2.1.223. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = Number.parseInt(left[i] ?? '0', 10) - Number.parseInt(right[i] ?? '0', 10);
    if (!Number.isNaN(diff) && diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

/** What the page says about the bundle it read, resolved or not. */
export interface CliBundleInfo {
  /** Absolute path, or null when no install could be located at all. */
  path: string | null;
  /** The version string — the directory entry's name, which is what the installer versions by. */
  version: string | null;
  exists: boolean;
  bytes: number;
  modified: string | null;
  /** Set when the bundle is missing or unreadable; the page renders this as its empty state. */
  error: string | null;
}

/** A resolved catalogue plus the bundle it was resolved against. */
export interface CliBundleCatalogue {
  bundle: CliBundleInfo;
  functions: CliFunctionEntry[];
  /** How long the resolving pass took, or null when it was served from cache. */
  durationMs: number | null;
}

/** Refuse a file too large to hold as a string. */
const MAX_BUNDLE_BYTES = 600 * 1024 * 1024;

/** One resolved bundle, keyed by identity so a CLI upgrade invalidates it. */
let cached: { key: string; catalogue: CliBundleCatalogue } | null = null;

/**
 * Resolve the catalogue against the installed bundle.
 *
 * Absent, unreadable and oversized bundles all come back as an empty catalogue with
 * `bundle.error` set rather than as a thrown request.
 */
export async function readCliCatalogue(bundlePath?: string | null): Promise<CliBundleCatalogue> {
  const resolved = bundlePath === undefined ? await resolveCliBundlePath() : bundlePath;
  const empty = (error: string | null, info: Partial<CliBundleInfo> = {}): CliBundleCatalogue => ({
    bundle: {
      path: resolved,
      version: resolved === null ? null : path.basename(resolved),
      exists: false,
      bytes: 0,
      modified: null,
      error,
      ...info,
    },
    functions: [],
    durationMs: null,
  });

  if (resolved === null) return empty('No Claude Code install found under ~/.local/share/claude/versions.');

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch (cause) {
    // SAFETY: `stat` rejects with a Node `ErrnoException`, so `code` is the errno string
    // the runtime attached; the `??` covers a rejection that carries none.
    return empty(`Bundle could not be read: ${(cause as NodeJS.ErrnoException).code ?? 'unknown error'}.`);
  }
  if (!info.isFile()) return empty('Bundle path is not a file.');
  if (info.size > MAX_BUNDLE_BYTES) {
    return empty(`Bundle is ${info.size} bytes, past the ${MAX_BUNDLE_BYTES}-byte cap for reading it into memory.`);
  }

  const bundle: CliBundleInfo = {
    path: resolved,
    version: path.basename(resolved),
    exists: true,
    bytes: info.size,
    modified: info.mtime.toISOString(),
    error: null,
  };

  const key = `${resolved}:${info.mtimeMs}:${info.size}`;
  if (cached?.key === key) return { ...cached.catalogue, bundle, durationMs: null };

  let functions: CliFunctionEntry[];
  const started = Date.now();
  try {
    // latin1 keeps one byte to one character, so the offsets below are byte offsets
    // and the detail view can seek straight to them.
    const text = (await readFile(resolved)).toString('latin1');
    functions = resolveCliCatalogue(text);
  } catch (cause) {
    // SAFETY: `readFile` rejects with a Node `ErrnoException`, so `code` is the errno
    // string the runtime attached; the `??` covers a rejection that carries none.
    return empty(`Bundle could not be read: ${(cause as NodeJS.ErrnoException).code ?? 'unknown error'}.`, {
      exists: true,
      bytes: info.size,
      modified: bundle.modified,
    });
  }
  const durationMs = Date.now() - started;

  cached = { key, catalogue: { bundle, functions, durationMs } };
  return { bundle, functions, durationMs };
}

/**
 * The source text of one resolved function, read back out of the bundle at its
 * cached offset. Returns null when the entry never resolved, or when the bundle
 * changed under us and the offset no longer covers it.
 */
export async function readCliFunctionSource(entry: CliFunctionEntry, bundlePath: string): Promise<string | null> {
  if (entry.offset === null || entry.length === null) return null;

  const handle = await open(bundlePath, 'r');
  try {
    const buffer = Buffer.alloc(entry.length);
    const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset);
    if (bytesRead < entry.length) return null;
    return buffer.toString('latin1');
  } finally {
    await handle.close();
  }
}

/** Drop the cached resolution, so a test does not see another test's bundle. */
export function resetCliCatalogueCache(): void {
  cached = null;
}
