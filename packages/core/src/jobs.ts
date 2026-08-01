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

/** A string field, or "" for anything that isn't one. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A finite number field, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Epoch milliseconds as ISO 8601, or "" when the value isn't a usable instant. */
function isoFromEpoch(value: unknown): string {
  const ms = num(value);
  if (ms === null) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** The value following `flag` in a `respawnFlags` array, or "". */
function flagValue(flags: unknown, flag: string): string {
  if (!Array.isArray(flags)) return "";
  const at = flags.indexOf(flag);
  return at >= 0 ? str(flags[at + 1]) : "";
}

function normalizeChildren(value: unknown): JobChild[] {
  if (!Array.isArray(value)) return [];
  const out: JobChild[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as { id?: unknown; kind?: unknown; href?: unknown };
    const href = str(c.href);
    if (!href) continue; // a child with nothing to open is not worth a row
    out.push({ id: str(c.id), kind: str(c.kind), href });
  }
  return out;
}

function normalizeFan(value: unknown): JobFanTask[] {
  if (!Array.isArray(value)) return [];
  const out: JobFanTask[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as { id?: unknown; kind?: unknown; label?: unknown; startedAt?: unknown };
    out.push({ id: str(f.id), kind: str(f.kind), label: str(f.label), startedAt: isoFromEpoch(f.startedAt) });
  }
  return out;
}

function normalizeInFlight(value: unknown): JobStateFields["inFlight"] {
  if (!value || typeof value !== "object") return null;
  const f = value as { tasks?: unknown; queued?: unknown; kinds?: unknown };
  const kinds = Array.isArray(f.kinds) ? f.kinds.filter((k): k is string => typeof k === "string") : [];
  return { tasks: num(f.tasks) ?? 0, queued: num(f.queued) ?? 0, kinds };
}

/**
 * Shape a parsed `state.json` into {@link JobStateFields}. Tolerant by design —
 * an unreadable or half-written file yields all-empty fields rather than an error,
 * which is how a job directory left behind with no state renders as a husk.
 */
export function normalizeJobState(raw: unknown): JobStateFields {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    state: str(s.state),
    name: str(s.name),
    nameSource: str(s.nameSource),
    detail: str(s.detail),
    intent: str(s.intent),
    tempo: str(s.tempo),
    cwd: str(s.cwd) || str(s.originCwd),
    sessionId: str(s.sessionId),
    backend: str(s.backend),
    template: str(s.template),
    cliVersion: str(s.cliVersion),
    model: flagValue(s.respawnFlags, "--model"),
    agent: flagValue(s.respawnFlags, "--agent"),
    tokens: num(s.tokens),
    createdAt: str(s.createdAt),
    updatedAt: str(s.updatedAt),
    firstTerminalAt: str(s.firstTerminalAt),
    children: normalizeChildren(s.children),
    fan: normalizeFan(s.fan),
    inFlight: normalizeInFlight(s.inFlight),
  };
}

/**
 * How a job's state reads at a glance. Deliberately coarse: Claude Code owns the
 * state vocabulary and can add to it, so an unrecognised word is `unknown` rather
 * than forced into one of the others.
 */
export type JobTone = "busy" | "done" | "blocked" | "failed" | "idle" | "unknown";

/** Known state words, after lowercasing and folding `_`/spaces to `-`. */
const STATE_TONES: Record<string, JobTone> = {
  working: "busy",
  running: "busy",
  active: "busy",
  starting: "busy",
  spawning: "busy",
  done: "done",
  complete: "done",
  completed: "done",
  finished: "done",
  resolved: "done",
  "needs-input": "blocked",
  input: "blocked",
  blocked: "blocked",
  waiting: "blocked",
  failed: "failed",
  error: "failed",
  errored: "failed",
  crashed: "failed",
  idle: "idle",
  queued: "idle",
  paused: "idle",
  stopped: "idle",
  cancelled: "idle",
  canceled: "idle",
};

/** Classify a raw `state` word into a {@link JobTone}. */
export function jobStateTone(state: string): JobTone {
  const key = state.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return STATE_TONES[key] ?? "unknown";
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

/**
 * Parse a job's `timeline.jsonl` — one JSON record per line, newest last. Lines
 * that don't parse are counted rather than thrown on, since the file is appended
 * to live and its last line can be half-written when it is read.
 */
export function parseJobTimeline(content: string): { entries: JobTimelineEntry[]; skipped: number } {
  const entries: JobTimelineEntry[] = [];
  let skipped = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      skipped += 1;
      continue;
    }
    const r = parsed as { at?: unknown; state?: unknown; detail?: unknown; text?: unknown };
    entries.push({ line: i + 1, at: str(r.at), state: str(r.state), detail: str(r.detail), text: str(r.text) });
  }
  return { entries, skipped };
}

/** How a viewer should render a job file. */
export type JobFileKind = "json" | "jsonl" | "markdown" | "log" | "code" | "text" | "image" | "binary";

/** Extension → kind. Anything unlisted is `binary` until the read proves otherwise. */
const FILE_KINDS: Record<string, JobFileKind> = {
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  md: "markdown",
  markdown: "markdown",
  log: "log",
  txt: "text",
  trigger: "text",
  lock: "text",
  pid: "text",
  env: "text",
  csv: "text",
  js: "code",
  mjs: "code",
  cjs: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  mts: "code",
  cts: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  fish: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  c: "code",
  h: "code",
  cc: "code",
  cpp: "code",
  css: "code",
  scss: "code",
  html: "code",
  xml: "code",
  yml: "code",
  yaml: "code",
  toml: "code",
  ini: "code",
  sql: "code",
  patch: "code",
  diff: "code",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  ico: "image",
};

/** The lowercased extension of a file name, or "" when it has none. */
export function fileExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Classify a job file by name. A hint, not a verdict: an extensionless file is
 * assumed to be text (the daemon drops marker files with no extension), and the
 * server downgrades anything whose bytes turn out to be binary.
 */
export function jobFileKind(name: string): JobFileKind {
  const ext = fileExtension(name);
  if (ext === "") return "text";
  return FILE_KINDS[ext] ?? "binary";
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
  return { path, dir: true, bytes: 0, modified: "", kind: null };
}

/** The directory holding `path`, or "" when it sits at the job root. */
function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
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
      if (existing.modified === "" && entry.modified !== "") Object.assign(existing, entry);
      return existing;
    }
    const segments = entry.path.split("/");
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
    if (entry.path === "") continue;
    ensure(entry);
    // Walk up so every ancestor exists before children are attached.
    let parent = parentPath(entry.path);
    while (parent !== "" && !nodes.has(parent)) {
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
