/**
 * Session suggestions: what the last N transcripts say about how to reach the
 * same outcome faster, with fewer steps, or with less context — and where the
 * guardrails got in the way.
 *
 * Sessions are numbered oldest-first and grouped into fixed windows of ten
 * ({@link SESSION_BUCKET_SIZE}), so bucket 1 always covers the same ten
 * transcripts as new ones arrive and the whole history can be recomputed from
 * scratch on every load.
 *
 * Pure: the rules read parsed transcripts (see `sessions.ts`) and, for the
 * per-bucket drill-down, the request breakdowns the server already computes
 * (see `context.ts`). No I/O, no clock.
 */

import type { Severity } from './advice.js';
import type { RequestBreakdown } from './context.js';
import { estTokens } from './context.js';
import { type SessionMeta, type SessionNode, sessionDisplayName } from './sessions.js';

/** How many sessions one bucket covers: 1–10, 11–20, … */
export const SESSION_BUCKET_SIZE = 10;

/** A transcript as the rules see it: its listing metadata plus its node stream. */
export interface SuggestibleSession extends SessionMeta {
  nodes: SessionNode[];
}

/** Where a suggestion came from — one session and the steps in it that show the pattern. */
export interface SuggestionSource {
  threadId: string;
  /** Title / subtitle / thread id — whatever names the session best. */
  label: string;
  /** Node indices exhibiting the pattern, so the transcript can be pointed at. */
  nodeIndexes: number[];
  /** One representative line, quoted verbatim. */
  sample: string | null;
}

/** One improvement the rules found across a bucket's sessions. */
export interface SessionSuggestion {
  id: string;
  severity: Severity;
  title: string;
  /** What to change, in the user's terms. */
  detail: string;
  /** What the rule actually counted — the claim's arithmetic. */
  evidence: string;
  /** The sessions it was counted in, strongest first. */
  sources: SuggestionSource[];
}

/** Editable thresholds for the suggestion rules. */
export const SUGGESTION_THRESHOLDS = {
  /** Blocked/denied tool results in a bucket before the guardrails get flagged. */
  minBlockedErrors: 2,
  /** Times one normalized error text must recur before it counts as repeated. */
  minRepeatedError: 2,
  /** Consecutive independent read-only calls that could have gone out together. */
  serialRunLength: 4,
  /** Times one session re-reads the same target before it counts as redundant. */
  minRepeatReads: 2,
  /** Tool calls per task above which a bucket is doing too many steps. */
  highToolsPerTask: 25,
  /** Tasks with no recorded outcome before the bucket is flagged as stalling. */
  minUnfinishedTasks: 2,
  /** Share of tool calls that are discovery before the bucket is search-heavy. */
  discoveryRatio: 0.55,
  /** Tool calls a bucket needs before ratio rules are meaningful. */
  minToolsForRatio: 20,
  /** Share of a bucket's errors one tool must own to be called error-prone. */
  errorProneToolPct: 40,
  /** Errors a bucket needs before the error-prone rule is meaningful. */
  minErrorsForBlame: 3,
  /** Share of an average request's bytes tool schemas must reach to be flagged. */
  toolSchemaPctOfRequest: 40,
  /** Share of an average request one single tool schema must reach to be flagged. */
  singleToolPctOfRequest: 12,
} as const;

const SEVERITY_RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

// --- Tool-signature helpers ------------------------------------------------
//
// A `tool` node's signature is the transcript's own truncated rendering, e.g.
// `Read(file_path=/repo/src/a…)`. Name and args are all that can be recovered.

const SIG_RE = /^([A-Za-z]\w*)\((.*)\)?$/;

/** The tool name from a call signature, or null when it doesn't parse. */
export function toolName(signature: string | null): string | null {
  if (!signature) return null;
  return SIG_RE.exec(signature)?.[1] ?? null;
}

/** Tools whose call only gathers information — safe to issue several at once. */
const DISCOVERY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);

/** Shell verbs that only inspect the tree — a `Bash(…)` running one is discovery too. */
const DISCOVERY_SHELL_RE = /\b(ls|find|cat|head|tail|wc|grep|rg|tree|stat|pwd|git\s+(status|log|diff|show))\b/;

/** True when this call only reads state, so peers like it could have run in parallel. */
export function isDiscoveryCall(signature: string | null): boolean {
  const name = toolName(signature);
  if (!name) return false;
  if (DISCOVERY_TOOLS.has(name)) return true;
  return name === 'Bash' && DISCOVERY_SHELL_RE.test(signature ?? '');
}

/** Error texts that mean a guardrail refused the call rather than the call failing. */
const BLOCKED_RE =
  /\b(blocked|permission|denied|not allowed|disallowed|requires? approval|unauthorized|refused|forbidden|rejected by hook)\b/i;

/**
 * Collapse an error's wording to what recurs: lowercased, with paths, numbers and
 * quoted fragments blanked, so "file not found: /a/b.ts" and "file not found:
 * /c/d.ts" count as the same problem.
 */
export function errorSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/~][\w./+-]+/g, '<path>')
    .replace(/\d+/g, '<n>')
    .replace(/["'`][^"'`]*["'`]/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** How a session names itself in a suggestion's sources. */
function sessionLabel(s: SuggestibleSession): string {
  return sessionDisplayName(s);
}

// --- Bucketing -------------------------------------------------------------

/** What a bucket's transcripts add up to. */
export interface SessionBucketStats {
  sessions: number;
  tasks: number;
  decisions: number;
  tools: number;
  errors: number;
  /** Tool calls per task — the crude "steps to an outcome" measure. 0 with no tasks. */
  toolsPerTask: number;
  /** Tasks that never recorded a `done:` outcome. */
  unfinishedTasks: number;
  /** Share of tool calls that only gather information, 0–1. */
  discoveryRatio: number;
  /** Most-called tools, most first, capped at 8. */
  topTools: { name: string; count: number }[];
}

/** Ten sessions (or the tail's remainder), scored and advised. */
export interface SessionBucket {
  /** 1-based bucket number: 1 covers sessions 1–10, 2 covers 11–20, … */
  index: number;
  /** 1-based inclusive session positions this bucket covers. */
  from: number;
  to: number;
  /** `"1–10"` — what the list shows. */
  label: string;
  /** Earliest and latest `started` in the bucket, or null when none carried one. */
  startedFirst: string | null;
  startedLast: string | null;
  /** The bucket's transcripts, oldest first. */
  threadIds: string[];
  stats: SessionBucketStats;
  suggestions: SessionSuggestion[];
}

/** Order sessions the way the buckets number them: oldest first, ties by thread id. */
function chronological<T extends { started: string | null; threadId: string }>(sessions: readonly T[]): T[] {
  return [...sessions].sort(
    (a, b) => (a.started ?? '').localeCompare(b.started ?? '') || a.threadId.localeCompare(b.threadId),
  );
}

/**
 * Split every session into fixed windows of {@link SESSION_BUCKET_SIZE}, oldest
 * first. The last bucket keeps whatever is left, so its label narrows rather than
 * claiming a full ten.
 */
export function bucketSessions<T extends { started: string | null; threadId: string }>(sessions: readonly T[]): T[][] {
  const ordered = chronological(sessions);
  const buckets: T[][] = [];
  for (let i = 0; i < ordered.length; i += SESSION_BUCKET_SIZE) {
    buckets.push(ordered.slice(i, i + SESSION_BUCKET_SIZE));
  }
  return buckets;
}

function bucketStats(sessions: readonly SuggestibleSession[]): SessionBucketStats {
  const counts = new Map<string, number>();
  let tools = 0;
  let discovery = 0;
  let unfinishedTasks = 0;

  for (const s of sessions) {
    // A task is finished once a `done:` follows it and before the next `## Task:`.
    let openTask = false;
    for (const node of s.nodes) {
      if (node.type === 'task') {
        if (openTask) unfinishedTasks += 1;
        openTask = true;
        continue;
      }
      if (node.type === 'done') {
        openTask = false;
        continue;
      }
      if (node.type !== 'tool') continue;
      tools += 1;
      if (isDiscoveryCall(node.tool)) discovery += 1;
      const name = toolName(node.tool);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (openTask) unfinishedTasks += 1;
  }

  const tasks = sessions.reduce((n, s) => n + s.tasks, 0);
  const topTools = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);

  return {
    sessions: sessions.length,
    tasks,
    decisions: sessions.reduce((n, s) => n + s.decisions, 0),
    tools,
    errors: sessions.reduce((n, s) => n + s.errors, 0),
    toolsPerTask: tasks === 0 ? 0 : Math.round((tools / tasks) * 10) / 10,
    unfinishedTasks,
    discoveryRatio: tools === 0 ? 0 : discovery / tools,
    topTools,
  };
}

// --- Rules -----------------------------------------------------------------
//
// Each rule reads the bucket's sessions and returns one suggestion or null.

type Rule = (sessions: readonly SuggestibleSession[], stats: SessionBucketStats) => SessionSuggestion | null;

/** Accumulate per-session hits into `SuggestionSource`s, strongest session first. */
function collectSources(hits: readonly { session: SuggestibleSession; node: SessionNode }[]): SuggestionSource[] {
  const bySession = new Map<string, { session: SuggestibleSession; nodes: SessionNode[] }>();
  for (const hit of hits) {
    const entry = bySession.get(hit.session.threadId);
    if (entry) entry.nodes.push(hit.node);
    else bySession.set(hit.session.threadId, { session: hit.session, nodes: [hit.node] });
  }
  return [...bySession.values()]
    .sort((a, b) => b.nodes.length - a.nodes.length || a.session.threadId.localeCompare(b.session.threadId))
    .map(({ session, nodes }) => ({
      threadId: session.threadId,
      label: sessionLabel(session),
      nodeIndexes: nodes.map((n) => n.index),
      sample: nodes[0]?.text ?? null,
    }));
}

/** Guardrails that refused a call — the restrictions worth revisiting. */
const blockedGuardrails: Rule = (sessions) => {
  const hits = sessions.flatMap((session) =>
    session.nodes.filter((n) => n.type === 'error' && BLOCKED_RE.test(n.text)).map((node) => ({ session, node })),
  );
  if (hits.length < SUGGESTION_THRESHOLDS.minBlockedErrors) return null;

  const sources = collectSources(hits);
  return {
    id: 'blocked-guardrails',
    severity: 'high',
    title: 'Guardrails refused calls these sessions needed',
    detail:
      "Each of these was a step the agent had already decided to take, so the refusal cost a turn and a retry rather than preventing work. Allowlist the ones that are routine here (settings.json `permissions.allow`, or the launch alias's `--disallowedTools`) and the same outcome arrives several steps earlier.",
    evidence: `${hits.length} refused tool result${hits.length === 1 ? '' : 's'} across ${sources.length} session${sources.length === 1 ? '' : 's'}`,
    sources,
  };
};

/** The same failure, again — usually a missing instruction rather than a flaky tool. */
const repeatedErrors: Rule = (sessions) => {
  const bySignature = new Map<string, { session: SuggestibleSession; node: SessionNode }[]>();
  for (const session of sessions) {
    for (const node of session.nodes) {
      if (node.type !== 'error') continue;
      const sig = errorSignature(node.text);
      if (!sig) continue;
      const list = bySignature.get(sig);
      if (list) list.push({ session, node });
      else bySignature.set(sig, [{ session, node }]);
    }
  }

  const repeated = [...bySignature.values()]
    .filter((hits) => hits.length >= SUGGESTION_THRESHOLDS.minRepeatedError)
    .sort((a, b) => b.length - a.length);
  if (repeated.length === 0) return null;

  const hits = repeated.flat();
  const worst = repeated[0]!;
  return {
    id: 'repeated-errors',
    severity: 'warn',
    title: 'The same error keeps being rediscovered',
    detail: `"${worst[0]!.node.text}" recurred ${worst.length} times. An error that repeats is one the agent could not have known to avoid — write the answer into AGENTS.md / CLAUDE.md once and every later session skips the failed attempt.`,
    evidence: `${repeated.length} error${repeated.length === 1 ? '' : 's'} recurred, ${hits.length} occurrence${hits.length === 1 ? '' : 's'} in total`,
    sources: collectSources(hits),
  };
};

/** Independent read-only calls issued one at a time — the cheapest latency win. */
const serialDiscovery: Rule = (sessions) => {
  const hits: { session: SuggestibleSession; node: SessionNode }[] = [];
  let runs = 0;

  for (const session of sessions) {
    let run: SessionNode[] = [];
    const flush = () => {
      if (run.length >= SUGGESTION_THRESHOLDS.serialRunLength) {
        runs += 1;
        for (const node of run) hits.push({ session, node });
      }
      run = [];
    };
    for (const node of session.nodes) {
      // Only an unbroken chain counts: a decision or an error between two calls
      // means the second depended on the first's answer.
      if (node.type === 'tool' && isDiscoveryCall(node.tool)) run.push(node);
      else flush();
    }
    flush();
  }

  if (runs === 0) return null;
  const sources = collectSources(hits);
  return {
    id: 'serial-discovery',
    severity: 'warn',
    title: 'Read-only calls went out one at a time',
    detail: `Runs of ${SUGGESTION_THRESHOLDS.serialRunLength}+ consecutive reads/greps with no decision between them are independent by construction — batching them into a single turn collapses that many round-trips into one, for the same steps and the same context.`,
    evidence: `${runs} serial run${runs === 1 ? '' : 's'} covering ${hits.length} calls across ${sources.length} session${sources.length === 1 ? '' : 's'}`,
    sources,
  };
};

/** The same file opened twice in one session — context paid for twice. */
const redundantReads: Rule = (sessions) => {
  const hits: { session: SuggestibleSession; node: SessionNode }[] = [];
  let targets = 0;

  for (const session of sessions) {
    const seen = new Map<string, SessionNode[]>();
    for (const node of session.nodes) {
      if (node.type !== 'tool' || !node.tool || toolName(node.tool) !== 'Read') continue;
      const list = seen.get(node.tool);
      if (list) list.push(node);
      else seen.set(node.tool, [node]);
    }
    for (const nodes of seen.values()) {
      if (nodes.length < SUGGESTION_THRESHOLDS.minRepeatReads + 1) continue;
      targets += 1;
      for (const node of nodes) hits.push({ session, node });
    }
  }

  if (targets === 0) return null;
  const sources = collectSources(hits);
  return {
    id: 'redundant-reads',
    severity: 'info',
    title: 'Files were re-read inside one session',
    detail:
      'A file already in the transcript is already in context — re-reading it pays for the same bytes twice and pushes the cache further out. Re-read only after an edit, and prefer a targeted offset/limit over the whole file.',
    evidence: `${targets} file${targets === 1 ? '' : 's'} read ${SUGGESTION_THRESHOLDS.minRepeatReads + 1}+ times, ${hits.length} reads across ${sources.length} session${sources.length === 1 ? '' : 's'}`,
    sources,
  };
};

/** Many steps per outcome — the "same result, fewer steps" lever. */
const highToolChurn: Rule = (sessions, stats) => {
  if (stats.tasks === 0 || stats.toolsPerTask < SUGGESTION_THRESHOLDS.highToolsPerTask) return null;
  const busiest = [...sessions].sort((a, b) => b.tools - a.tools || a.threadId.localeCompare(b.threadId)).slice(0, 3);
  return {
    id: 'high-tool-churn',
    severity: 'warn',
    title: 'Tasks are taking a lot of steps',
    detail: `These sessions averaged ${stats.toolsPerTask} tool calls per task. Stating the target files up front, or handing the sweep to one search agent instead of walking the tree call by call, gets to the same answer in a fraction of the turns.`,
    evidence: `${stats.tools} tool calls over ${stats.tasks} task${stats.tasks === 1 ? '' : 's'} (${stats.toolsPerTask}/task)`,
    sources: busiest.map((s) => ({
      threadId: s.threadId,
      label: sessionLabel(s),
      nodeIndexes: [],
      sample: `${s.tools} tool calls, ${s.tasks} task${s.tasks === 1 ? '' : 's'}`,
    })),
  };
};

/** Tasks that never reached an outcome — interruptions, or a scope that never closed. */
const unfinishedTasks: Rule = (sessions, stats) => {
  if (stats.unfinishedTasks < SUGGESTION_THRESHOLDS.minUnfinishedTasks) return null;
  const hits: { session: SuggestibleSession; node: SessionNode }[] = [];
  for (const session of sessions) {
    let openTask: SessionNode | null = null;
    for (const node of session.nodes) {
      if (node.type === 'task') {
        if (openTask) hits.push({ session, node: openTask });
        openTask = node;
      } else if (node.type === 'done') openTask = null;
    }
    if (openTask) hits.push({ session, node: openTask });
  }
  return {
    id: 'unfinished-tasks',
    severity: 'info',
    title: 'Tasks ended without a recorded outcome',
    detail:
      'A task with no `done:` was interrupted, compacted away, or drifted past its scope. The work is usually still on a branch — `/revive <thread id>` picks it back up rather than starting the same task twice.',
    evidence: `${stats.unfinishedTasks} of ${stats.tasks} task${stats.tasks === 1 ? '' : 's'} have no outcome line`,
    sources: collectSources(hits),
  };
};

/** Most of the effort spent finding things — a layout problem, not a work problem. */
const discoveryHeavy: Rule = (sessions, stats) => {
  if (stats.tools < SUGGESTION_THRESHOLDS.minToolsForRatio) return null;
  if (stats.discoveryRatio < SUGGESTION_THRESHOLDS.discoveryRatio) return null;
  const pct = Math.round(stats.discoveryRatio * 100);
  const busiest = [...sessions].sort((a, b) => b.tools - a.tools || a.threadId.localeCompare(b.threadId)).slice(0, 3);
  return {
    id: 'discovery-heavy',
    severity: 'info',
    title: 'Most calls were spent locating code, not changing it',
    detail: `${pct}% of tool calls only read or searched. Every session is re-deriving the same layout — an AGENTS.md that names the entry points, or a short map of the packages, converts that search into a single read.`,
    evidence: `${pct}% of ${stats.tools} tool calls were reads/searches`,
    sources: busiest.map((s) => ({
      threadId: s.threadId,
      label: sessionLabel(s),
      nodeIndexes: [],
      sample: `${s.tools} tool calls`,
    })),
  };
};

/** One tool responsible for most of the failures. */
const errorProneTool: Rule = (sessions, stats) => {
  if (stats.errors < SUGGESTION_THRESHOLDS.minErrorsForBlame) return null;

  const byTool = new Map<string, { session: SuggestibleSession; node: SessionNode }[]>();
  for (const session of sessions) {
    for (const node of session.nodes) {
      if (node.type !== 'error') continue;
      const name = toolName(node.tool) ?? '(unattributed)';
      const list = byTool.get(name);
      if (list) list.push({ session, node });
      else byTool.set(name, [{ session, node }]);
    }
  }

  const ranked = [...byTool].sort((a, b) => b[1].length - a[1].length);
  const top = ranked[0];
  if (!top || top[0] === '(unattributed)') return null;
  const total = ranked.reduce((n, [, hits]) => n + hits.length, 0);
  const pct = Math.round((top[1].length / total) * 100);
  if (pct < SUGGESTION_THRESHOLDS.errorProneToolPct) return null;

  return {
    id: 'error-prone-tool',
    severity: 'warn',
    title: `${top[0]} accounts for most failures`,
    detail: `${pct}% of failed results came from ${top[0]}. Pinning down its usage — the exact command form, the flags that work in this repo — removes a whole class of retries.`,
    evidence: `${top[1].length} of ${total} errors came from ${top[0]}`,
    sources: collectSources(top[1]),
  };
};

const RULES: Rule[] = [
  blockedGuardrails,
  repeatedErrors,
  serialDiscovery,
  redundantReads,
  highToolChurn,
  unfinishedTasks,
  discoveryHeavy,
  errorProneTool,
];

/** Run every rule over one bucket's sessions, most severe first. */
export function suggestBucket(sessions: readonly SuggestibleSession[]): SessionSuggestion[] {
  if (sessions.length === 0) return [];
  const stats = bucketStats(sessions);
  const out: SessionSuggestion[] = [];
  for (const rule of RULES) {
    const suggestion = rule(sessions, stats);
    if (suggestion) out.push(suggestion);
  }

  if (out.length === 0) {
    out.push({
      id: 'steady',
      severity: 'info',
      title: 'Nothing to trim in these sessions',
      detail: 'No blocked calls, repeated errors, serial reads, or step-count outliers tripped their thresholds.',
      evidence: `${stats.sessions} session${stats.sessions === 1 ? '' : 's'}, ${stats.tools} tool calls, ${stats.errors} errors`,
      sources: [],
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Every bucket of sessions, newest bucket first, each with its stats and
 * suggestions. Recomputed from the full transcript set on each call — there is no
 * incremental state to keep in sync, so a backfill and a refresh are the same
 * operation.
 */
export function sessionSuggestionBuckets(sessions: readonly SuggestibleSession[]): SessionBucket[] {
  const groups = bucketSessions(sessions);
  return groups
    .map((group, i) => {
      const from = i * SESSION_BUCKET_SIZE + 1;
      const to = from + group.length - 1;
      const started = group.map((s) => s.started).filter((s): s is string => !!s);
      return {
        index: i + 1,
        from,
        to,
        label: `${from}–${to}`,
        startedFirst: started[0] ?? null,
        startedLast: started[started.length - 1] ?? null,
        threadIds: group.map((s) => s.threadId),
        stats: bucketStats(group),
        suggestions: suggestBucket(group),
      };
    })
    .reverse();
}

// --- Request Breakdown patterns -------------------------------------------
//
// The drill-down's other half: what the bucket's sessions actually sent. Each
// session contributes its largest captured request, and the regions that repeat
// across them are the patterns worth cutting.

/** One session's peak request, as the pattern roll-up sees it. */
export interface BucketBreakdownInput {
  threadId: string;
  /** Sidecar base name — the `/context/$file` drill-down handle. */
  file: string;
  realInput: number;
  breakdown: RequestBreakdown;
}

/** A region that shows up across the bucket's peak requests. */
export interface BreakdownPattern {
  /** A tool schema's name, or the region's name for the non-tool parts. */
  name: string;
  kind: 'tool' | 'region';
  /** How many of the bucket's peak requests carried it. */
  requests: number;
  /** Mean bytes it contributed, over the requests that carried it. */
  avgBytes: number;
  avgEstTokens: number;
  /** Mean share of those requests' total bytes. */
  avgPctOfRequest: number;
  /** The requests it appears in, largest contribution first, capped at 10. */
  sources: { threadId: string; file: string; bytes: number }[];
}

/** What the bucket's peak requests look like, and what repeats inside them. */
export interface BucketBreakdownSummary {
  /** How many of the bucket's sessions contributed a captured request. */
  requests: number;
  avgTotalBytes: number;
  avgSystemBytes: number;
  avgToolsBytes: number;
  avgMessagesBytes: number;
  avgToolCount: number;
  avgMessageCount: number;
  maxRealInput: number;
  /** Regions and tool schemas, largest average contribution first. */
  patterns: BreakdownPattern[];
  /** The requests `avgToolsBytes` was averaged over, heaviest schemas first, capped at 10. */
  toolsSources: { threadId: string; file: string; bytes: number }[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.round(values.reduce((n, v) => n + v, 0) / values.length);

const EMPTY_BREAKDOWN_SUMMARY: BucketBreakdownSummary = {
  requests: 0,
  avgTotalBytes: 0,
  avgSystemBytes: 0,
  avgToolsBytes: 0,
  avgMessagesBytes: 0,
  avgToolCount: 0,
  avgMessageCount: 0,
  maxRealInput: 0,
  patterns: [],
  toolsSources: [],
};

/**
 * Roll one bucket's peak requests into the regions they share: the system prompt,
 * the conversation, and each tool schema — with how many requests carried each and
 * what it cost on average. Pure.
 */
export function summarizeBreakdownPatterns(inputs: readonly BucketBreakdownInput[]): BucketBreakdownSummary {
  if (inputs.length === 0) return EMPTY_BREAKDOWN_SUMMARY;

  interface Acc {
    kind: 'tool' | 'region';
    bytes: number[];
    pcts: number[];
    sources: { threadId: string; file: string; bytes: number }[];
  }
  const acc = new Map<string, Acc>();
  const add = (name: string, kind: 'tool' | 'region', bytes: number, total: number, input: BucketBreakdownInput) => {
    if (bytes <= 0) return;
    const entry = acc.get(name) ?? { kind, bytes: [], pcts: [], sources: [] };
    entry.bytes.push(bytes);
    entry.pcts.push(total > 0 ? (bytes / total) * 100 : 0);
    entry.sources.push({ threadId: input.threadId, file: input.file, bytes });
    acc.set(name, entry);
  };

  const messagesBytes: number[] = [];
  for (const input of inputs) {
    const b = input.breakdown;
    const msgBytes = b.messages.reduce((n, m) => n + m.bytes, 0);
    messagesBytes.push(msgBytes);
    add('System prompt', 'region', b.systemBytes, b.totalBytes, input);
    add('Conversation messages', 'region', msgBytes, b.totalBytes, input);
    for (const tool of b.tools) add(tool.name, 'tool', tool.bytes, b.totalBytes, input);
  }

  const patterns: BreakdownPattern[] = [...acc]
    .map(([name, entry]) => ({
      name,
      kind: entry.kind,
      requests: entry.bytes.length,
      avgBytes: mean(entry.bytes),
      avgEstTokens: estTokens(mean(entry.bytes)),
      avgPctOfRequest: Math.round((entry.pcts.reduce((n, v) => n + v, 0) / entry.pcts.length) * 10) / 10,
      sources: entry.sources.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    }))
    .sort((a, b) => b.avgBytes - a.avgBytes || a.name.localeCompare(b.name));

  return {
    requests: inputs.length,
    avgTotalBytes: mean(inputs.map((i) => i.breakdown.totalBytes)),
    avgSystemBytes: mean(inputs.map((i) => i.breakdown.systemBytes)),
    avgToolsBytes: mean(inputs.map((i) => i.breakdown.toolsBytes)),
    avgMessagesBytes: mean(messagesBytes),
    avgToolCount: mean(inputs.map((i) => i.breakdown.toolCount)),
    avgMessageCount: mean(inputs.map((i) => i.breakdown.messageCount)),
    maxRealInput: Math.max(...inputs.map((i) => i.realInput)),
    patterns,
    toolsSources: inputs
      .filter((i) => i.breakdown.toolsBytes > 0)
      .map((i) => ({ threadId: i.threadId, file: i.file, bytes: i.breakdown.toolsBytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10),
  };
}

/**
 * Suggestions the breakdown patterns support but the transcripts cannot: what the
 * bucket's requests spend their bytes on. Sources point at the captured requests
 * the claim was measured from.
 */
export function suggestFromBreakdown(summary: BucketBreakdownSummary): SessionSuggestion[] {
  if (summary.requests === 0 || summary.avgTotalBytes === 0) return [];
  const out: SessionSuggestion[] = [];

  const toolsPct = (summary.avgToolsBytes / summary.avgTotalBytes) * 100;
  if (toolsPct >= SUGGESTION_THRESHOLDS.toolSchemaPctOfRequest) {
    out.push({
      id: 'bucket-tool-schema-heavy',
      severity: 'warn',
      title: 'Tool schemas dominate these requests',
      detail: `Tool definitions are ~${toolsPct.toFixed(0)}% of the average request in this bucket, on every turn, whether or not the tools get used. Withholding the ones these sessions never called is the largest single context cut available.`,
      evidence: `~${summary.avgToolsBytes.toLocaleString()} of ~${summary.avgTotalBytes.toLocaleString()} average bytes, over ${summary.requests} request${summary.requests === 1 ? '' : 's'}`,
      sources: summary.toolsSources.map((s) => ({
        threadId: s.threadId,
        label: s.file,
        nodeIndexes: [],
        sample: `${s.bytes.toLocaleString()} bytes of tool schemas`,
      })),
    });
  }

  const constant = summary.patterns.find(
    (p) =>
      p.kind === 'tool' &&
      p.requests === summary.requests &&
      p.avgPctOfRequest >= SUGGESTION_THRESHOLDS.singleToolPctOfRequest,
  );
  if (constant) {
    out.push({
      id: 'bucket-constant-tool',
      severity: 'warn',
      title: `"${constant.name}" is in every request in this bucket`,
      detail: `It carries ~${constant.avgEstTokens.toLocaleString()} tokens (~${constant.avgPctOfRequest}% of the request) each time. If these sessions did not need it, disabling it removes that cost from every turn they ever take.`,
      evidence: `present in all ${constant.requests} captured requests, ~${constant.avgBytes.toLocaleString()} bytes each`,
      sources: constant.sources.map((s) => ({
        threadId: s.threadId,
        label: s.file,
        nodeIndexes: [],
        sample: `${s.bytes.toLocaleString()} bytes`,
      })),
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
