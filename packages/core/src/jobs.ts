/**
 * Device background jobs — what each `~/.claude/jobs/<id>` directory records,
 * shaped for the dashboard's "Jobs" page.
 *
 * Filesystem view, not traffic: a job is Claude Code's own scratch directory for a
 * background session, so none of this comes through the proxy. The server reads the
 * directory and passes the parsed values in.
 *
 * Pure: no I/O.
 */
import {
  arrayAt,
  type JsonValue,
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonText,
  jsonValueOf,
  numberAt,
  parseJsonText,
  textAt,
} from './json.js';

/** A linked artifact a job produced — a PR, an issue, a branch. */
export interface JobChild {
  id: string;
  /** What it links to, e.g. `pr`. */
  kind: string;
  href: string;
}

/** One task the job had in flight when its state was last written. */
export interface JobFanTask {
  id: string;
  /** `shell`, `local_bash`, an agent name — whatever the job called it. */
  kind: string;
  /** The command or tool label, as the job recorded it. */
  label: string;
  /** Start time, ISO 8601 — converted from the epoch ms the file stores; "" if absent. */
  startedAt: string;
}

/**
 * What a job's `state.json` says about itself. Every field degrades to empty rather
 * than throwing: the file is rewritten by another process while the job runs, so any
 * key can be absent, null, or a shape this doesn't expect.
 */
export interface JobStateFields {
  /** Lifecycle word the job last wrote, e.g. `working`, `done`. "" when absent. */
  state: string;
  /** Human label, user-given or auto-derived. */
  name: string;
  /** `user` or `auto` — where {@link name} came from. */
  nameSource: string;
  /** One-line status the job publishes as it goes. */
  detail: string;
  /** The prompt that started it. */
  intent: string;
  /** How hard it is being driven, e.g. `active`. */
  tempo: string;
  /** Directory it runs in. */
  cwd: string;
  /** Claude Code session id — the transcript this job's requests carry. */
  sessionId: string;
  /** How it is hosted, e.g. `daemon`. */
  backend: string;
  /** Job template, e.g. `claude`. */
  template: string;
  cliVersion: string;
  /** `--model` from `respawnFlags`; "" when it runs the default. */
  model: string;
  /** `--agent` from `respawnFlags`. */
  agent: string;
  /** Context tokens at the last write; null when the file records none. */
  tokens: number | null;
  createdAt: string;
  updatedAt: string;
  /** When it first reached a terminal state; "" while it never has. */
  firstTerminalAt: string;
  children: JobChild[];
  fan: JobFanTask[];
  /** Work outstanding at the last write; null when the file records none. */
  inFlight: { tasks: number; queued: number; kinds: string[] } | null;
}

/** Epoch milliseconds as ISO 8601, or "" when the value isn't a usable instant. */
function isoFromEpoch(value: JsonValue | undefined): string {
  const ms = jsonNumber(value);
  if (ms === null) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** The value following `flag` in a `respawnFlags` array, or "". */
function flagValue(flags: JsonValue | undefined, flag: string): string {
  const list = jsonArray(flags);
  if (list === null) return '';
  const at = list.indexOf(flag);
  return at >= 0 ? (jsonText(list[at + 1]) ?? '') : '';
}

function normalizeChildren(value: JsonValue | undefined): JobChild[] {
  const out: JobChild[] = [];
  for (const entry of jsonArray(value) ?? []) {
    const child = jsonObject(entry);
    if (child === null) continue;
    const href = textAt(child, 'href');
    if (!href) continue; // a child with nothing to open is not worth a row
    out.push({ id: textAt(child, 'id'), kind: textAt(child, 'kind'), href });
  }
  return out;
}

function normalizeFan(value: JsonValue | undefined): JobFanTask[] {
  const out: JobFanTask[] = [];
  for (const entry of jsonArray(value) ?? []) {
    const task = jsonObject(entry);
    if (task === null) continue;
    out.push({
      id: textAt(task, 'id'),
      kind: textAt(task, 'kind'),
      label: textAt(task, 'label'),
      startedAt: isoFromEpoch(task.startedAt),
    });
  }
  return out;
}

function normalizeInFlight(value: JsonValue | undefined): JobStateFields['inFlight'] {
  const record = jsonObject(value);
  if (record === null) return null;
  const kinds: string[] = [];
  for (const kind of arrayAt(record, 'kinds')) {
    const name = jsonText(kind);
    if (name !== null) kinds.push(name);
  }
  return { tasks: numberAt(record, 'tasks'), queued: numberAt(record, 'queued'), kinds };
}

/**
 * Shape a parsed `state.json` into {@link JobStateFields}. Tolerant by design —
 * an unreadable or half-written file yields all-empty fields rather than an error,
 * which is how a job directory left behind with no state renders as a husk.
 *
 * The parameter is generic rather than a `JsonValue`, because the server reads and
 * parses `state.json` itself and passes the result straight in; `Candidate` lets it
 * keep whatever type its reader gave that value.
 */
export function normalizeJobState<Candidate>(raw: Candidate): JobStateFields {
  const s = jsonObject(jsonValueOf(raw));
  return {
    state: textAt(s, 'state'),
    name: textAt(s, 'name'),
    nameSource: textAt(s, 'nameSource'),
    detail: textAt(s, 'detail'),
    intent: textAt(s, 'intent'),
    tempo: textAt(s, 'tempo'),
    cwd: textAt(s, 'cwd') || textAt(s, 'originCwd'),
    sessionId: textAt(s, 'sessionId'),
    backend: textAt(s, 'backend'),
    template: textAt(s, 'template'),
    cliVersion: textAt(s, 'cliVersion'),
    model: flagValue(s?.respawnFlags, '--model'),
    agent: flagValue(s?.respawnFlags, '--agent'),
    tokens: jsonNumber(s?.tokens),
    createdAt: textAt(s, 'createdAt'),
    updatedAt: textAt(s, 'updatedAt'),
    firstTerminalAt: textAt(s, 'firstTerminalAt'),
    children: normalizeChildren(s?.children),
    fan: normalizeFan(s?.fan),
    inFlight: normalizeInFlight(s?.inFlight),
  };
}

/**
 * How a job's state reads at a glance. Deliberately coarse: Claude Code owns the
 * state vocabulary and can add to it, so an unrecognised word is `unknown` rather
 * than forced into one of the others.
 */
export type JobTone = 'busy' | 'done' | 'blocked' | 'failed' | 'idle' | 'unknown';

/** The lookup {@link STATE_TONES} is: any folded state word, or nothing. */
interface StateToneTable {
  readonly [word: string]: JobTone;
}

/** Known state words, after lowercasing and folding `_`/spaces to `-`. */
const STATE_TONES: StateToneTable = {
  working: 'busy',
  running: 'busy',
  active: 'busy',
  starting: 'busy',
  spawning: 'busy',
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  resolved: 'done',
  'needs-input': 'blocked',
  input: 'blocked',
  blocked: 'blocked',
  waiting: 'blocked',
  failed: 'failed',
  error: 'failed',
  errored: 'failed',
  crashed: 'failed',
  idle: 'idle',
  queued: 'idle',
  paused: 'idle',
  stopped: 'idle',
  cancelled: 'idle',
  canceled: 'idle',
};

/** Classify a raw `state` word into a {@link JobTone}. */
export function jobStateTone(state: string): JobTone {
  const key = state
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return STATE_TONES[key] ?? 'unknown';
}

/** One record from a job's `timeline.jsonl`. */
export interface JobTimelineEntry {
  /** Line number in the file, 1-based — the record's handle. */
  line: number;
  /** When it was recorded, ISO 8601; "" when the record has no `at`. */
  at: string;
  state: string;
  detail: string;
  /** The narration captured with the state change; often long, often "". */
  text: string;
}

/** A parsed `timeline.jsonl`: the records that read, and how many did not. */
export interface JobTimeline {
  entries: JobTimelineEntry[];
  /** Lines that were not a JSON record — a half-written tail, most often. */
  skipped: number;
}

/**
 * Parse a job's `timeline.jsonl` — one JSON record per line, newest last. Lines
 * that don't parse are counted rather than thrown on, since the file is appended
 * to live and its last line can be half-written when it is read.
 */
export function parseJobTimeline(content: string): JobTimeline {
  const entries: JobTimelineEntry[] = [];
  let skipped = 0;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '') continue;
    const record = jsonObject(parseJsonText(raw) ?? undefined);
    if (record === null) {
      skipped += 1;
      continue;
    }
    entries.push({
      line: i + 1,
      at: textAt(record, 'at'),
      state: textAt(record, 'state'),
      detail: textAt(record, 'detail'),
      text: textAt(record, 'text'),
    });
  }
  return { entries, skipped };
}

/** How a viewer should render a job file. */
export type JobFileKind = 'json' | 'jsonl' | 'markdown' | 'log' | 'code' | 'text' | 'image' | 'binary';

/** The lookup {@link FILE_KINDS} is: any lowercased extension, or nothing. */
interface FileKindTable {
  readonly [extension: string]: JobFileKind;
}

/** Extension → kind. Anything unlisted is `binary` until the read proves otherwise. */
const FILE_KINDS: FileKindTable = {
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  md: 'markdown',
  markdown: 'markdown',
  log: 'log',
  txt: 'text',
  trigger: 'text',
  lock: 'text',
  pid: 'text',
  env: 'text',
  csv: 'text',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  mts: 'code',
  cts: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  css: 'code',
  scss: 'code',
  html: 'code',
  xml: 'code',
  yml: 'code',
  yaml: 'code',
  toml: 'code',
  ini: 'code',
  sql: 'code',
  patch: 'code',
  diff: 'code',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  ico: 'image',
};

/** The lowercased extension of a file name, or "" when it has none. */
export function fileExtension(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classify a job file by name. A hint, not a verdict: an extensionless file is
 * assumed to be text (the daemon drops marker files with no extension), and the
 * server downgrades anything whose bytes turn out to be binary.
 */
export function jobFileKind(name: string): JobFileKind {
  const ext = fileExtension(name);
  if (ext === '') return 'text';
  return FILE_KINDS[ext] ?? 'binary';
}

/** One entry from the walk of a job directory. */
export interface JobFileEntry {
  /** Path relative to the job directory, `/`-separated. */
  path: string;
  dir: boolean;
  bytes: number;
  /** Last-modified time, ISO 8601. */
  modified: string;
  /** Viewer hint; null for a directory. */
  kind: JobFileKind | null;
  /** A directory the walk listed but deliberately did not descend into. */
  skipped?: boolean;
  /** A symlink — listed, never followed. */
  link?: boolean;
}

/** A {@link JobFileEntry} placed in the folder tree, with its subtree rolled up. */
export interface JobTreeNode extends JobFileEntry {
  /** Last path segment. */
  name: string;
  /** 0 for the job directory's own children. */
  depth: number;
  children: JobTreeNode[];
  /** Files at or below this node; 1 for a file. */
  files: number;
  /** Bytes at or below this node. */
  totalBytes: number;
}

/** A directory the walk implied but never listed (a file reported below it). */
function syntheticDir(path: string): JobFileEntry {
  return { path, dir: true, bytes: 0, modified: '', kind: null };
}

/** The directory holding `path`, or "" when it sits at the job root. */
function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Nest a flat walk into a folder tree: directories before files, each alphabetical,
 * with file counts and byte totals rolled up through every level. Intermediate
 * directories a walk didn't list are synthesized, so a partial or truncated walk
 * still nests instead of dropping the entries beneath a missing parent.
 */
export function buildJobTree(entries: readonly JobFileEntry[]): JobTreeNode[] {
  const nodes = new Map<string, JobTreeNode>();

  const ensure = (entry: JobFileEntry): JobTreeNode => {
    const existing = nodes.get(entry.path);
    // A real entry supersedes the placeholder its child created for it.
    if (existing) {
      if (existing.modified === '' && entry.modified !== '') Object.assign(existing, entry);
      return existing;
    }
    const segments = entry.path.split('/');
    const node: JobTreeNode = {
      ...entry,
      name: segments[segments.length - 1] ?? entry.path,
      depth: segments.length - 1,
      children: [],
      files: entry.dir ? 0 : 1,
      totalBytes: entry.dir ? 0 : entry.bytes,
    };
    nodes.set(entry.path, node);
    return node;
  };

  for (const entry of entries) {
    if (entry.path === '') continue;
    ensure(entry);
    // Walk up so every ancestor exists before children are attached.
    let parent = parentPath(entry.path);
    while (parent !== '' && !nodes.has(parent)) {
      ensure(syntheticDir(parent));
      parent = parentPath(parent);
    }
  }

  const roots: JobTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentPath(node.path));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortAndTally = (list: JobTreeNode[]): void => {
    list.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    for (const node of list) {
      if (!node.dir) continue;
      sortAndTally(node.children);
      node.files = node.children.reduce((sum, c) => sum + c.files, 0);
      node.totalBytes = node.children.reduce((sum, c) => sum + c.totalBytes, 0);
    }
  };
  sortAndTally(roots);
  return roots;
}
