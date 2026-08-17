import { lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildJobTree,
  type JobFileEntry,
  type JobFileKind,
  type JobStateFields,
  type JobTreeNode,
  jobFileKind,
  jobStateTone,
  normalizeJobState,
} from '@claude-proxy/core';
import { errorMessage } from './errors.js';
import type { JsonValue } from './json.js';

/** Default location of Claude Code's background jobs: `~/.claude/jobs`. */
export function defaultJobsDir(): string {
  return path.join(os.homedir(), '.claude', 'jobs');
}

/** Resolve the jobs directory: `CLAUDE_JOBS` env override, else the default. */
export function resolveJobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_JOBS ? path.resolve(env.CLAUDE_JOBS) : defaultJobsDir();
}

/** A job id is the short daemon id Claude Code names the directory with. The value
 * comes from the URL, so anything carrying a path separator or a `..` is rejected
 * before it reaches disk. */
const JOB_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** How much of a job directory one walk will report before it stops. */
const MAX_TREE_ENTRIES = 4000;

/** How deep it will descend. A job's own files are shallow; its `tmp/` need not be. */
const MAX_TREE_DEPTH = 8;

/** Directories listed but never descended into — thousands of files, none of them
 * the job's own work. */
const NO_DESCEND = new Set(['node_modules', '.git', '.pnpm-store', '.cache']);

/** How much of a text file the viewer is given. Beyond this it is truncated, and
 * the response says so. */
const MAX_TEXT_BYTES = 512_000;

/** How large an image may be and still be inlined as a data URL. */
const MAX_IMAGE_BYTES = 4_000_000;

/** Lowercased extension → mime type, for the images the viewer inlines. */
const IMAGE_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
]);

/** One job directory: what its `state.json` says, plus what the directory holds. */
export interface JobSummary extends JobStateFields {
  /** Directory name under the jobs root — also the route param. */
  id: string;
  /** False when `state.json` is missing or unparseable: a directory left behind
   * after its job went away, which the page shows as a husk. */
  stateReadable: boolean;
  /** Files anywhere in the directory. */
  files: number;
  /** Total bytes of those files. */
  bytes: number;
  /** Newest mtime anywhere in the directory; "" for an empty directory. */
  modified: string;
  /** Newest of `updatedAt` and {@link modified} — what the listing sorts by, so a
   * husk with no state still sorts by when it was last touched. */
  activity: string;
}

/** A job's folder tree, and whether the walk saw all of it. */
export interface JobTreeResult {
  tree: JobTreeNode[];
  /** Entries the walk reported (before nesting). */
  entries: number;
  /** True when the walk hit {@link MAX_TREE_ENTRIES} and stopped early. */
  truncated: boolean;
}

/** One file's contents, shaped for the pretty/raw viewer. */
export interface JobFileDetail {
  id: string;
  /** Path relative to the job directory. */
  path: string;
  name: string;
  kind: JobFileKind;
  bytes: number;
  modified: string;
  /** `utf8` for text, `base64` for an inlined image. */
  encoding: 'utf8' | 'base64';
  /** The file's contents; "" when nothing was read (binary, or too large). */
  content: string;
  /** Set for an inlined image, so the client can build a data URL. */
  mime: string | null;
  /** True when only the first {@link MAX_TEXT_BYTES} were read. */
  truncated: boolean;
  /** True when the bytes aren't text and weren't read. */
  binary: boolean;
  /** Why nothing was read, when that's the case. */
  note: string | null;
}

/** Resolve a job's directory, validating the (URL-supplied) id and confirming the
 * resolved path stays directly inside `jobsDir`. */
function resolveJobDir(jobsDir: string, id: string): string {
  if (!JOB_ID_RE.test(id)) throw new Error(`invalid job id: ${id}`);
  const dir = path.resolve(jobsDir, id);
  if (path.dirname(dir) !== path.resolve(jobsDir)) throw new Error(`invalid job id: ${id}`);
  return dir;
}

/**
 * Walk one job directory breadth-first, reporting every file and directory as a
 * path relative to the job root. Symlinks are listed but never followed, and the
 * heavy dependency directories an agent's `tmp/` collects are listed without being
 * descended into — both so a walk can't wander out of the job or take unbounded
 * time. Unreadable subdirectories are skipped rather than failing the walk.
 */
/** One directory still to be listed by {@link walkJobDir}, and where it sits. */
interface JobWalkStep {
  abs: string;
  rel: string;
  depth: number;
}

/** What one walk saw, and whether it saw all of it. */
interface JobWalkResult {
  entries: JobFileEntry[];
  truncated: boolean;
}

async function walkJobDir(jobDir: string): Promise<JobWalkResult> {
  const entries: JobFileEntry[] = [];
  let truncated = false;
  const queue: JobWalkStep[] = [{ abs: jobDir, rel: '', depth: 0 }];

  while (queue.length > 0) {
    // SAFETY: the `while` condition is `queue.length > 0`, and nothing else shifts this
    // queue, so `shift()` cannot be the `undefined` its signature admits.
    const { abs, rel, depth } = queue.shift() as JobWalkStep;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      continue; // permissions, or it vanished mid-walk
    }

    for (const dirent of dirents) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        return { entries, truncated };
      }

      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const childAbs = path.join(abs, dirent.name);
      const link = dirent.isSymbolicLink();

      let info: import('node:fs').Stats;
      try {
        info = await stat(childAbs);
      } catch {
        continue; // dangling symlink, or removed between readdir and stat
      }

      // A symlinked directory is a leaf: following it could leave the job entirely.
      const isDir = info.isDirectory() && !link;
      const noDescend = isDir && (NO_DESCEND.has(dirent.name) || depth + 1 >= MAX_TREE_DEPTH);
      const entry: JobFileEntry = {
        path: childRel,
        dir: isDir,
        bytes: isDir ? 0 : info.size,
        modified: info.mtime.toISOString(),
        kind: isDir ? null : jobFileKind(dirent.name),
      };
      // Both flags stay off the entry rather than being written `false`: the tree the
      // client reads carries them only for the rows they are true of.
      if (noDescend) entry.skipped = true;
      if (link) entry.link = true;
      entries.push(entry);
      if (isDir && !noDescend) queue.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
    }
  }

  return { entries, truncated };
}

/** Read and normalize one job's `state.json`. Never throws: a missing or malformed
 * file yields empty fields and `readable: false`. */
async function readJobState(jobDir: string): Promise<{ state: JobStateFields; readable: boolean }> {
  try {
    const parsed: JsonValue = JSON.parse(await readFile(path.join(jobDir, 'state.json'), 'utf8'));
    return { state: normalizeJobState(parsed), readable: true };
  } catch {
    return { state: normalizeJobState(null), readable: false };
  }
}

/** The counts a listing row carries, rolled up from one walk. */
interface JobTally {
  files: number;
  bytes: number;
  modified: string;
}

/** Roll a walk up into the counts the listing shows. */
function tally(entries: readonly JobFileEntry[]): JobTally {
  let files = 0;
  let bytes = 0;
  let modified = '';
  for (const entry of entries) {
    if (entry.dir) continue;
    files += 1;
    bytes += entry.bytes;
    if (entry.modified > modified) modified = entry.modified;
  }
  return { files, bytes, modified };
}

/**
 * Every job directory on the device, newest activity first. A directory with no
 * readable `state.json` is still listed — that is the husk left behind when a job
 * is gone but its scratch space isn't, and hiding it would misreport what is on
 * disk. Throws only if the jobs root itself cannot be read.
 */
export async function listJobs(jobsDir: string): Promise<JobSummary[]> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await readdir(jobsDir, { withFileTypes: true });
  } catch (cause) {
    throw new Error(`cannot read jobs directory ${jobsDir}: ${errorMessage(cause)}`);
  }

  const jobs: JobSummary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !JOB_ID_RE.test(dirent.name)) continue;
    const jobDir = path.join(jobsDir, dirent.name);
    const [{ state, readable }, { entries }] = await Promise.all([readJobState(jobDir), walkJobDir(jobDir)]);
    const counts = tally(entries);
    jobs.push({
      ...state,
      id: dirent.name,
      stateReadable: readable,
      ...counts,
      activity: state.updatedAt > counts.modified ? state.updatedAt : counts.modified,
    });
  }

  jobs.sort((a, b) => b.activity.localeCompare(a.activity) || a.id.localeCompare(b.id));
  return jobs;
}

/**
 * One job's state plus its folder tree. Throws a labelled error the server maps to
 * 400 (bad id) / 404 (no such directory).
 */
export async function readJob(jobsDir: string, id: string): Promise<{ job: JobSummary; tree: JobTreeResult }> {
  const jobDir = resolveJobDir(jobsDir, id);
  try {
    const info = await stat(jobDir);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`job not found: ${id}`);
  }

  const [{ state, readable }, { entries, truncated }] = await Promise.all([readJobState(jobDir), walkJobDir(jobDir)]);
  const counts = tally(entries);
  return {
    job: {
      ...state,
      id,
      stateReadable: readable,
      ...counts,
      activity: state.updatedAt > counts.modified ? state.updatedAt : counts.modified,
    },
    tree: { tree: buildJobTree(entries), entries: entries.length, truncated },
  };
}

/** What a delete removed, read off the directory just before it went. */
export interface JobDeleteResult {
  id: string;
  /** Absolute path of the directory that was removed. */
  path: string;
  files: number;
  bytes: number;
  /** What its `state.json` last said. */
  name: string;
  state: string;
}

/**
 * Delete one job directory and everything under it. The only destructive operation in
 * the API, so it is deliberately narrow:
 *
 * - the id is validated and re-confirmed to resolve directly inside `jobsDir`;
 * - a symlinked job directory is refused outright rather than followed — following it
 *   would delete outside the root;
 * - a job whose state reads as `busy` is refused: its daemon is still writing there.
 *
 * Returns what was on disk immediately before removal. Throws a labelled error the
 * server maps to 400 (bad id) / 404 (no such directory) / 409 (still running).
 */
export async function deleteJob(jobsDir: string, id: string): Promise<JobDeleteResult> {
  const jobDir = resolveJobDir(jobsDir, id);

  const info = await lstat(jobDir).catch(() => {
    throw new Error(`job not found: ${id}`);
  });
  if (info.isSymbolicLink()) throw new Error(`job directory is a symlink, refusing to delete: ${id}`);
  if (!info.isDirectory()) throw new Error(`job not found: ${id}`);

  // The id check above is textual; this confirms where it lands.
  const [real, realRoot] = await Promise.all([realpath(jobDir), realpath(jobsDir)]);
  if (path.dirname(real) !== realRoot) throw new Error(`invalid job id: ${id}`);

  const [{ state }, { entries }] = await Promise.all([readJobState(jobDir), walkJobDir(jobDir)]);
  if (jobStateTone(state.state) === 'busy') {
    throw new Error(`job is still running, stop it before deleting: ${id}`);
  }

  const counts = tally(entries);
  await rm(real, { recursive: true, force: true });
  return { id, path: real, files: counts.files, bytes: counts.bytes, name: state.name, state: state.state };
}

/** Validate a (URL-supplied) relative file path segment by segment. */
function safeSegments(relPath: string): string[] {
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\')) {
      throw new Error(`invalid job file path: ${relPath}`);
    }
  }
  return segments;
}

/** Whether a buffer looks like binary rather than text: a NUL byte never appears in
 * UTF-8 text, and is the cheapest reliable tell. */
function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * Read one file inside a job directory for the viewer. Validates the id and every
 * path segment, then confirms the *real* path (symlinks resolved) is still inside
 * the job directory before reading — a symlink an agent left in its `tmp/` must not
 * become a way to read the rest of the filesystem.
 *
 * Text is capped at {@link MAX_TEXT_BYTES} and marked `truncated`; an image under
 * {@link MAX_IMAGE_BYTES} comes back base64 for the client to inline; anything whose
 * bytes turn out to be binary is reported with a note and no content. Throws a
 * labelled error the server maps to 400 / 404.
 */
export async function readJobFile(jobsDir: string, id: string, relPath: string): Promise<JobFileDetail> {
  const jobDir = resolveJobDir(jobsDir, id);
  const segments = safeSegments(relPath);
  const full = path.resolve(jobDir, ...segments);

  // Compare resolved paths on both sides so a symlinked home doesn't read as an escape.
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(full), realpath(jobDir)]);
  } catch {
    throw new Error(`job file not found: ${relPath}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`invalid job file path: ${relPath}`);
  }

  const info = await stat(real).catch(() => {
    throw new Error(`job file not found: ${relPath}`);
  });
  if (info.isDirectory()) throw new Error(`job file is a directory: ${relPath}`);

  // SAFETY: `safeSegments` throws on any empty segment, and `String.split` always yields
  // at least one member, so the last index is populated.
  const name = segments[segments.length - 1] as string;
  const kind = jobFileKind(name);
  const base = {
    id,
    path: relPath,
    name,
    bytes: info.size,
    modified: info.mtime.toISOString(),
    mime: null,
    truncated: false,
    binary: false,
    note: null,
  };

  if (kind === 'image') {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (info.size > MAX_IMAGE_BYTES) {
      return { ...base, kind, encoding: 'utf8', content: '', binary: true, note: 'image too large to inline' };
    }
    const buf = await readFile(real);
    return { ...base, kind, encoding: 'base64', content: buf.toString('base64'), mime: IMAGE_MIME.get(ext) ?? null };
  }

  if (kind === 'binary') {
    return { ...base, kind, encoding: 'utf8', content: '', binary: true, note: 'binary file — not read' };
  }

  const buf = await readFile(real);
  const slice = buf.subarray(0, MAX_TEXT_BYTES);
  if (looksBinary(slice)) {
    return { ...base, kind: 'binary', encoding: 'utf8', content: '', binary: true, note: 'binary file — not read' };
  }
  return {
    ...base,
    kind,
    encoding: 'utf8',
    content: slice.toString('utf8'),
    truncated: buf.length > slice.length,
  };
}
