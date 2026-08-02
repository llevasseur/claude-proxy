import {
  analyzeRequestBody,
  computeDigest,
  deriveRequestErrors,
  deriveSessionNodes,
  linkRequestErrors,
  extractRequestMessage,
  extractRequestTool,
  buildUsageLimits,
  computeSkimDigest,
  digestsByDay,
  heuristicAdvice,
  skimDigestsByDay,
  summarizeContext,
  toContextEntry,
  computeAliasPosture,
  flattenHooks,
  normalizePlugins,
  hookPluginLoadExpectations,
  jobStateTone,
  parseSessionErrors,
  reportDay,
  sessionContextPeak,
  sessionSuggestionBuckets,
  countSuggestionRecurrences,
  countSuggestionStatuses,
  suggestionStatusRows,
  suggestFromBreakdown,
  summarizeBreakdownPatterns,
  withheldReport,
  type Advice,
  type AliasLoadExpectation,
  type ContextEntry,
  type ContextSummary,
  type HookRow,
  type LaunchAlias,
  type LaunchAliasPosture,
  type PluginRow,
  type RequestBreakdown,
  type RequestMessageDetail,
  type RequestToolDetail,
  type BucketBreakdownInput,
  type BucketBreakdownSummary,
  type LinkedSessionError,
  type RequestErrorSite,
  type SessionBucket,
  type SessionContextPeak,
  type SessionError,
  type SessionErrorLink,
  type SessionMeta,
  type SessionNode,
  type JobTreeNode,
  type SessionSuggestion,
  type SuggestionRecurrence,
  type SuggestionStatus,
  type SuggestionStatusRow,
  type SuggestionStatusUpdate,
  type SkimDigest,
  type SkimShape,
  type TopTool,
  type UsageDigest,
  type UsageLimitConfig,
  type UsageLimitsSnapshot,
  type WithheldReport,
  PROXY_FILTER_INVENTORY,
  filterRunsByFlags,
  patternFrequency,
  runKey,
  runTotals,
  stepReach,
  summarizeCommands,
  type CommandPattern,
  type CommandRun,
  type CommandStep,
  type CommandSummary,
  type FiltersResponse,
  type PatternFrequency,
  type StepReach,
} from "@claude-proxy/core";
import { loadArchivedDigest } from "./archive.js";
import { listInstalledCommands } from "./command-runs.js";
import { fileSource, type SidecarSource } from "./db/source.js";
import { readArchivedDay, readRequestBody, shiftDay, today } from "./logs.js";
import { loadArchivedUsage, loadLearnedCeilings } from "./usage-history.js";
import { loadLiveUsage } from "./usage-live.js";
import {
  deleteJob,
  listJobs,
  readJob,
  readJobFile,
  type JobDeleteResult,
  type JobFileDetail,
  type JobSummary,
} from "./jobs.js";
import {
  listProjectMemories,
  listProjects,
  readMemory,
  type MemoryDetail,
  type MemoryFileSummary,
  type ProjectSummary,
} from "./projects.js";
import {
  threadIdForBody,
  type SessionDetail,
  type SessionGraph,
  type SessionNodeTexts,
  type SessionSummary,
} from "./sessions.js";
import { readDeviceSettings, resolveSettingsPath } from "./settings.js";
import { readSuggestionStatusStore, resolveSuggestionStatusPath, updateSuggestionStatusStore } from "./suggestion-status.js";
import { readLaunchAliases } from "./shell-rc.js";

export interface SummaryResponse {
  digest: UsageDigest;
  advice: Advice[];
  meta: { date: string; files: number; parseErrors: number };
}

/**
 * One day's digest + advice, with the trend computed against the prior day.
 *
 * `source` selects where the sidecars come from: the directory scan by default,
 * the SQLite substrate when the parity harness or shadow mode asks for it. See
 * `server/src/db/source.ts`.
 */
export async function buildSummary(
  logDir: string,
  date?: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SummaryResponse> {
  const day = date ?? today(now);
  const prevDay = shiftDay(day, -1);
  const [cur, prev] = await Promise.all([
    source.readSidecars(logDir, { date: day }, now),
    source.readSidecars(logDir, { date: prevDay }, now),
  ]);
  const priorDigest = computeDigest(prev.sidecars, { date: prevDay });
  const digest = computeDigest(cur.sidecars, { date: day, priorDigest });
  const advice = await heuristicAdvice.advise(digest);
  return { digest, advice, meta: { date: day, files: cur.files, parseErrors: cur.parseErrors } };
}

export interface UsageResponse {
  usage: UsageLimitsSnapshot;
  meta: { files: number; parseErrors: number };
}

/**
 * One sidecar per source file, first occurrence winning.
 *
 * Archiving is expected to *move* files, so live and archived reads should not
 * overlap — but a copy-based archiver would double every request in the seam.
 * Entries without a `__file` are passed through rather than collapsed together.
 */
function dedupeByFile(sidecars: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const s of sidecars) {
    const file = (s as { __file?: unknown })?.__file;
    if (typeof file !== "string") {
      out.push(s);
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(s);
  }
  return out;
}

/**
 * The live usage meters, over the trailing week — the widest window any meter
 * spans. `sinceDays: 8` rather than 7 because the filter is day-granular while the
 * windows are instant-granular; the extra day covers the partial day.
 *
 * The live directory holds roughly a day, so on its own it leaves a weekly window
 * counting a few hours and calling it a week. Archived days are read alongside it,
 * and the retained days passed through so `coverage` can see a hole in the window.
 * Ceilings come from a wider slice again, precomputed and cached — see
 * `usage-history.ts`.
 */
export async function buildUsage(
  logDir: string,
  limits: UsageLimitConfig,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<UsageResponse> {
  const live = await source.readSidecars(logDir, { sinceDays: 8, includeFile: true }, now);
  const archived = await loadArchivedUsage(logDir, now, source);
  const learned = await loadLearnedCeilings(logDir, now, source);

  const liveUsage = await loadLiveUsage(logDir, now);

  const sidecars = dedupeByFile([...live.sidecars, ...archived.sidecars]);
  // The live directory is the current day's destination, so that day is retained
  // whether or not anything landed in it; days a live sidecar names are retained
  // too, for a deployment that rotates less eagerly than the default.
  const retainedDays = new Set<string>([today(now), ...archived.retainedDays]);
  for (const s of live.sidecars) {
    const ts = (s as { timestamp?: unknown })?.timestamp;
    const day = typeof ts === "string" ? reportDay(ts) : null;
    if (day) retainedDays.add(day);
  }

  return {
    usage: buildUsageLimits(sidecars, {
      limits,
      learned,
      retainedDays: [...retainedDays],
      live: liveUsage.live,
      anchors: liveUsage.anchors,
      now,
    }),
    meta: { files: sidecars.length, parseErrors: live.parseErrors + archived.parseErrors },
  };
}

export interface TrendsResponse {
  digests: UsageDigest[];
  meta: { days: number; files: number; parseErrors: number; archivedDays: number };
}

// Archived days are immutable, so their digests are cached for the process
// lifetime. Misses aren't cached — a day can still gain its archive later.
const rawArchiveDigests = new Map<string, UsageDigest>();

/** Test-only: drop the in-process raw-archive digest cache. */
export function clearRawArchiveCache(): void {
  rawArchiveDigests.clear();
}

/**
 * One archived day's digest, computed from the raw sidecars the summary job
 * moved into `<logDir>/archive/<date>/`. `null` when that day isn't archived.
 */
async function rawArchivedDigest(logDir: string, date: string, source: SidecarSource): Promise<UsageDigest | null> {
  // Keyed by backing as well as day: the parity harness computes both, and a
  // shared entry would hand the second run the first one's answer.
  const key = `${source.kind} ${logDir} ${date}`;
  const hit = rawArchiveDigests.get(key);
  if (hit) return hit;

  const { sidecars, files } = await source.readArchivedDay(logDir, date);
  if (files === 0) return null;

  const digest = computeDigest(sidecars, { date });
  rawArchiveDigests.set(key, digest);
  return digest;
}

/**
 * Per-day digests for the last `days` days, oldest→newest. The live `logs/` dir
 * only retains the current day or two; older days come from the raw sidecars in
 * `<logDir>/archive/<date>/`, and failing that from the archive of finalized
 * digests. Live days win over both for the same date.
 */
export async function buildTrends(
  logDir: string,
  days: number,
  now: Date = new Date(),
  archiveDir?: string,
  source: SidecarSource = fileSource,
): Promise<TrendsResponse> {
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { sinceDays: days }, now);
  const byDate = new Map<string, UsageDigest>();
  for (const d of digestsByDay(sidecars)) byDate.set(d.date, d);

  let archivedDays = 0;
  const end = today(now);
  for (let i = 0; i < days; i += 1) {
    const date = shiftDay(end, -i);
    if (byDate.has(date)) continue;
    const digest =
      (await rawArchivedDigest(logDir, date, source)) ?? (archiveDir ? await loadArchivedDigest(archiveDir, date) : null);
    if (digest) {
      byDate.set(date, digest);
      archivedDays += 1;
    }
  }

  const digests = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { digests, meta: { days, files, parseErrors, archivedDays } };
}

export interface ToolsResponse {
  date: string;
  topTools: TopTool[];
  meta: { files: number; parseErrors: number };
}

/** The full ranked tool-bloat table for a day. */
export async function buildTools(
  logDir: string,
  date?: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<ToolsResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { date: day }, now);
  const digest = computeDigest(sidecars, { date: day, topN: 200 });
  return { date: day, topTools: digest.topTools, meta: { files, parseErrors } };
}

export interface ContextResponse {
  summary: ContextSummary;
  meta: { days: number; files: number; parseErrors: number };
}

/**
 * Sidecars read with `includeFile: true`, reduced to the context entries that
 * parsed. A sidecar with no `__file` handle has nothing to drill into, so it is
 * dropped.
 */
function toContextEntries(sidecars: readonly unknown[]): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (const s of sidecars) {
    const file = (s as { __file?: string }).__file;
    const entry = file ? toContextEntry(s, file) : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Context-size analytics over the last `days` days: average / median / max real
 * input tokens, plus the largest requests (each with a `file` handle for the
 * drill-down). Reads only `.audit.json` sidecars — same cost as the trends view.
 */
export async function buildContext(
  logDir: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<ContextResponse> {
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { sinceDays: days, includeFile: true }, now);
  return { summary: summarizeContext(toContextEntries(sidecars)), meta: { days, files, parseErrors } };
}

export interface ContextDetailResponse {
  file: string;
  breakdown: RequestBreakdown;
  /** Full request JSON, pretty-printed (possibly truncated). */
  raw: string;
  truncated: boolean;
}

/**
 * The "why was it so large?" drill-down for one captured request: its
 * system/tools/message breakdown plus the raw request JSON. Reads exactly one
 * `.request.txt`. `file` is validated in {@link readRequestBody}.
 */
export async function buildContextDetail(logDir: string, file: string): Promise<ContextDetailResponse> {
  const { body, raw, truncated } = await readRequestBody(logDir, file);
  return { file, breakdown: analyzeRequestBody(body), raw, truncated };
}

export interface ContextMessageResponse {
  file: string;
  message: RequestMessageDetail;
}

/**
 * The full content of one conversation message from a captured request. Reads
 * exactly one `.request.txt` (via {@link readRequestBody}, which validates
 * `file`) and slices out message `index`. The parsed body is always complete
 * even when the drill-down's raw JSON was truncated, so any message resolves.
 * Throws a labelled error the server maps to 404 when `index` is out of range.
 */
export async function buildContextMessage(logDir: string, file: string, index: number): Promise<ContextMessageResponse> {
  const { body } = await readRequestBody(logDir, file);
  const message = extractRequestMessage(body, index);
  if (!message) throw new Error(`message index out of range: ${index}`);
  return { file, message };
}

export interface ContextToolResponse {
  file: string;
  tool: RequestToolDetail;
}

/**
 * The full schema of one tool from a captured request. Reads exactly one
 * `.request.txt` (via {@link readRequestBody}, which validates `file`) and
 * slices out tool `index`. The parsed body is always complete even when the
 * drill-down's raw JSON was truncated, so any tool resolves. Throws a labelled
 * error the server maps to 404 when `index` is out of range.
 */
export async function buildContextTool(logDir: string, file: string, index: number): Promise<ContextToolResponse> {
  const { body } = await readRequestBody(logDir, file);
  const tool = extractRequestTool(body, index);
  if (!tool) throw new Error(`tool index out of range: ${index}`);
  return { file, tool };
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  meta: { projectsDir: string; total: number };
}

/** Every Claude Code project that has a `memory/` dir, with its memory count. */
export async function buildProjects(projectsDir: string): Promise<ProjectsResponse> {
  const projects = await listProjects(projectsDir);
  return { projects, meta: { projectsDir, total: projects.length } };
}

export interface ProjectMemoriesResponse {
  project: string;
  files: MemoryFileSummary[];
  meta: { total: number };
}

/** The `*.md` memory files for one project. `project` is validated downstream. */
export async function buildProjectMemories(projectsDir: string, project: string): Promise<ProjectMemoriesResponse> {
  const files = await listProjectMemories(projectsDir, project);
  return { project, files, meta: { total: files.length } };
}

export interface MemoryResponse {
  memory: MemoryDetail;
}

/** One memory file's full contents. `project`/`name` are validated downstream. */
export async function buildMemory(projectsDir: string, project: string, name: string): Promise<MemoryResponse> {
  return { memory: await readMemory(projectsDir, project, name) };
}

export interface JobsResponse {
  jobs: JobSummary[];
  meta: {
    jobsDir: string;
    total: number;
    /** How many are in a `busy` state right now. */
    running: number;
    /** Directories with no readable `state.json` — scratch space outliving its job. */
    husks: number;
    /** Files across every job, and their total bytes. */
    files: number;
    bytes: number;
  };
}

/**
 * Every background job directory on the device, newest activity first. A device
 * view, not a traffic one: these directories are Claude Code's own scratch space,
 * so nothing here comes from the captured logs.
 */
export async function buildJobs(jobsDir: string): Promise<JobsResponse> {
  const jobs = await listJobs(jobsDir);
  return {
    jobs,
    meta: {
      jobsDir,
      total: jobs.length,
      running: jobs.filter((j) => jobStateTone(j.state) === "busy").length,
      husks: jobs.filter((j) => !j.stateReadable).length,
      files: jobs.reduce((sum, j) => sum + j.files, 0),
      bytes: jobs.reduce((sum, j) => sum + j.bytes, 0),
    },
  };
}

export interface JobResponse {
  job: JobSummary;
  /** The job directory as a folder tree, directories before files. */
  tree: JobTreeNode[];
  meta: { entries: number; truncated: boolean };
}

/** One job's state plus its folder tree. `id` is validated downstream. */
export async function buildJob(jobsDir: string, id: string): Promise<JobResponse> {
  const { job, tree } = await readJob(jobsDir, id);
  return { job, tree: tree.tree, meta: { entries: tree.entries, truncated: tree.truncated } };
}

export interface JobFileResponse {
  file: JobFileDetail;
}

/** One file inside a job directory, for the pretty/raw viewer. Both params are
 * validated downstream, where the path is also confirmed to stay inside the job. */
export async function buildJobFile(jobsDir: string, id: string, file: string): Promise<JobFileResponse> {
  return { file: await readJobFile(jobsDir, id, file) };
}

export interface JobDeleteResponse {
  deleted: JobDeleteResult;
  /** The listing as it stands after the delete. */
  jobs: JobsResponse;
}

/**
 * Delete one job directory from disk, then hand back the refreshed listing. `id` is
 * validated downstream, which also refuses a still-running job and a symlinked directory.
 */
export async function buildJobDelete(jobsDir: string, id: string): Promise<JobDeleteResponse> {
  const deleted = await deleteJob(jobsDir, id);
  return { deleted, jobs: await buildJobs(jobsDir) };
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  meta: { sessionsDir: string; total: number };
}

/** Every session transcript the proxy has written, newest first. */
export async function buildSessions(logDir: string, source: SidecarSource = fileSource): Promise<SessionsResponse> {
  const sessions = await source.listSessions(logDir);
  return { sessions, meta: { sessionsDir: `${logDir}/sessions`, total: sessions.length } };
}

export interface SessionsGraphResponse {
  sessions: SessionGraph[];
  meta: { sessionsDir: string; total: number };
}

/** Every session transcript with its structured node stream, newest first — feeds the live graph. */
export async function buildSessionsGraph(logDir: string, source: SidecarSource = fileSource): Promise<SessionsGraphResponse> {
  const sessions = await source.listSessionGraphs(logDir);
  return { sessions, meta: { sessionsDir: `${logDir}/sessions`, total: sessions.length } };
}

export type SessionNodeTextsResponse = SessionNodeTexts;

/**
 * The untruncated text behind one session's truncated node lines. Kept off the
 * polling `/api/sessions/graph`, where it would dwarf the gists. `id` is validated
 * downstream.
 */
export async function buildSessionNodeTexts(
  logDir: string,
  id: string,
  source: SidecarSource = fileSource,
): Promise<SessionNodeTextsResponse> {
  return source.readSessionNodeTexts(logDir, id);
}

export interface SessionResponse {
  session: SessionDetail;
}

/** One session transcript's full contents. `id` is validated downstream. */
export async function buildSession(
  logDir: string,
  id: string,
  source: SidecarSource = fileSource,
): Promise<SessionResponse> {
  return { session: await source.readSession(logDir, id) };
}

export interface SessionErrorsResponse {
  threadId: string;
  meta: SessionMeta;
  errors: LinkedSessionError[];
}

/**
 * Every errored tool result in one session, re-linked to its task and tool call, and
 * where possible to the request message that holds the failed turn. Reuses
 * {@link readSession}, which validates `id` and maps to 400/404.
 *
 * An error the session's captures can't account for comes back with no link rather
 * than failing the page.
 */
export async function buildSessionErrors(
  logDir: string,
  id: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionErrorsResponse> {
  const { meta, content } = await source.readSession(logDir, id);
  const errors = parseSessionErrors(content);
  const { requests } = await resolveSessionRequests(logDir, meta, now, source);
  const links = await linkErrorsToRequests(logDir, requests, errors);

  return { threadId: id, meta, errors: errors.map((error, i) => ({ ...error, link: links[i] ?? null })) };
}

/**
 * How many request bodies one errors page will open — a busy session captures hundreds,
 * each up to megabytes of JSON. See {@link requestsToScan} for which ones.
 */
const MAX_ERROR_REQUEST_SCANS = 6;

/**
 * Find the request message behind each error. Each body links whichever errors it can
 * and later ones only fill the gaps, so different errors can point at different
 * requests, and the scan stops once every error has a home.
 */
async function linkErrorsToRequests(
  logDir: string,
  requests: readonly ContextEntry[],
  errors: readonly SessionError[],
): Promise<(SessionErrorLink | null)[]> {
  const links: (SessionErrorLink | null)[] = errors.map(() => null);
  if (errors.length === 0) return links;

  for (const request of requestsToScan(requests)) {
    const sites = await readRequestErrorSites(logDir, request.file);
    if (sites.length === 0) continue;

    const found = linkRequestErrors(errors, sites);
    let unlinked = 0;
    for (let i = 0; i < links.length; i += 1) {
      const messageIndex = found[i];
      if (links[i] === null && messageIndex != null) links[i] = { file: request.file, messageIndex };
      if (links[i] === null) unlinked += 1;
    }
    if (unlinked === 0) break;
  }
  return links;
}

/**
 * Which of a session's requests to open: the peak, then an even walk along the
 * session's timeline.
 *
 * Taking the largest few instead is the wrong shape: the biggest bodies cluster at the
 * end of a run and, once a session has compacted, are precisely the ones that have
 * dropped its early failures — on a 193-request session the only body still holding the
 * first error ranked 43rd by size. Errors are spread through a session, so sampling its
 * timeline reaches them in far fewer reads. The peak leads as the body most likely to
 * carry a turn at all.
 */
export function requestsToScan(requests: readonly ContextEntry[]): ContextEntry[] {
  if (requests.length === 0) return [];

  const byTime = [...requests].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const picked = [requests.reduce((max, e) => (e.realInput > max.realInput ? e : max))];
  const take = (entry: ContextEntry): void => {
    if (!picked.some((p) => p.file === entry.file)) picked.push(entry);
  };

  const samples = MAX_ERROR_REQUEST_SCANS - 1;
  for (let i = 1; i <= samples; i += 1) take(byTime[Math.round((i / samples) * (byTime.length - 1))]!);

  // A set inside the budget repeats samples, so the rest of the timeline fills the
  // spare reads. Order stays peak-first, the same shape a large set is scanned in.
  if (requests.length <= MAX_ERROR_REQUEST_SCANS) for (const entry of byTime) take(entry);
  return picked;
}

/** A captured request's errored tool results, or none when the body has gone or won't parse. */
async function readRequestErrorSites(logDir: string, file: string): Promise<RequestErrorSite[]> {
  try {
    const { body } = await readRequestBody(logDir, file);
    return deriveRequestErrors(body);
  } catch {
    return [];
  }
}

export interface SessionBreakdownResponse extends SessionContextPeak {
  threadId: string;
  /** The Claude Code session id the requests were matched on; null if the transcript has none. */
  sessionId: string | null;
  meta: { files: number; parseErrors: number };
}

/**
 * Every request sent under a session's id, plus the largest of them and the sidecar
 * counts behind the scan. Reads from the session's start date onward — a session's
 * requests never predate it — or the whole log when it has no start. A transcript with
 * no session id has nothing to match on and scans nothing.
 */
async function resolveSessionRequests(
  logDir: string,
  meta: SessionMeta,
  now: Date,
  source: SidecarSource,
): Promise<
  SessionContextPeak & { sessionId: string | null; requests: ContextEntry[]; files: number; parseErrors: number }
> {
  const sessionId = meta.sessionId;
  if (!sessionId) {
    return { sessionId: null, requests: [], requestCount: 0, peak: null, files: 0, parseErrors: 0 };
  }

  const since = (meta.started && reportDay(meta.started)) || undefined;
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { since, includeFile: true }, now);
  const entries = toContextEntries(sidecars);

  return {
    sessionId,
    requests: entries.filter((e) => e.sessionId === sessionId),
    ...sessionContextPeak(entries, sessionId),
    files,
    parseErrors,
  };
}

/**
 * The captured request a session links to for its breakdown: the largest one sent
 * under its session id.
 */
export async function buildSessionBreakdown(
  logDir: string,
  id: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionBreakdownResponse> {
  const { meta } = await source.readSession(logDir, id);
  const { sessionId, requestCount, peak, files, parseErrors } = await resolveSessionRequests(logDir, meta, now, source);

  return { threadId: id, sessionId, requestCount, peak, meta: { files, parseErrors } };
}

export interface SessionSuggestionsResponse {
  buckets: SessionBucket[];
  meta: { sessionsDir: string; sessions: number; buckets: number };
}

/**
 * Every ten-session window, newest first, with what its transcripts say about
 * reaching the same outcome in fewer steps. Recomputed from every transcript on
 * each call — there is no backfill state to keep in sync.
 */
export async function buildSessionSuggestions(
  logDir: string,
  source: SidecarSource = fileSource,
): Promise<SessionSuggestionsResponse> {
  const sessions = await source.listSessionGraphs(logDir);
  const buckets = sessionSuggestionBuckets(sessions);
  return {
    buckets,
    meta: { sessionsDir: `${logDir}/sessions`, sessions: sessions.length, buckets: buckets.length },
  };
}

export interface SessionSuggestionBucketResponse {
  bucket: SessionBucket;
  /** The transcripts it covers, oldest first — the drill-down's session list. */
  sessions: SessionSummary[];
  /** What the bucket's peak requests are made of, and what repeats across them. */
  breakdown: BucketBreakdownSummary;
  /** Suggestions the breakdown supports that the transcripts alone cannot. */
  breakdownSuggestions: SessionSuggestion[];
  meta: { files: number; parseErrors: number; requestsMissing: number };
}

/**
 * One bucket's drill-down: its suggestions, the sessions behind them, and the
 * Request Breakdown patterns that recur across those sessions' largest captured
 * requests. Each session contributes at most one request (its peak), so the
 * pattern roll-up compares like with like and reads at most ten request bodies.
 * Throws a labelled error the server maps to 404 when `index` names no bucket.
 */
export async function buildSessionSuggestionBucket(
  logDir: string,
  index: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionSuggestionBucketResponse> {
  const graphs = await source.listSessionGraphs(logDir);
  const bucket = sessionSuggestionBuckets(graphs).find((b) => b.index === index);
  if (!bucket) throw new Error(`suggestion bucket not found: ${index}`);

  const byThread = new Map(graphs.map((g) => [g.threadId, g]));
  // Bucket order is the authority on which sessions belong and in what order.
  const sessions = bucket.threadIds
    .map((id) => byThread.get(id))
    .filter((g): g is (typeof graphs)[number] => !!g)
    .map(({ nodes: _nodes, ...row }) => row as SessionSummary);

  // A session's requests never predate it, so the earliest start bounds the scan.
  const since = (bucket.startedFirst && reportDay(bucket.startedFirst)) || undefined;
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { since, includeFile: true }, now);
  const entries = toContextEntries(sidecars);

  const peaks = sessions
    .map((s) => ({ threadId: s.threadId, peak: sessionContextPeak(entries, s.sessionId).peak }))
    .filter((p): p is { threadId: string; peak: ContextEntry } => !!p.peak);

  const inputs: BucketBreakdownInput[] = [];
  for (const { threadId, peak } of peaks) {
    try {
      const { body } = await readRequestBody(logDir, peak.file);
      inputs.push({ threadId, file: peak.file, realInput: peak.realInput, breakdown: analyzeRequestBody(body) });
    } catch {
      // The sidecar outlived its captured body (retention) — the rest still summarizes.
    }
  }

  const breakdown = summarizeBreakdownPatterns(inputs);
  return {
    bucket,
    sessions,
    breakdown,
    breakdownSuggestions: suggestFromBreakdown(breakdown),
    meta: { files, parseErrors, requestsMissing: sessions.length - inputs.length },
  };
}

export interface SuggestionStatusResponse {
  rows: SuggestionStatusRow[];
  meta: {
    /** Where the flags are stored. */
    statusFile: string;
    /** Bucket indexes that exist, ascending — what a range can name. */
    buckets: number[];
    /** Bucket indexes the caller asked for that don't exist, if any. */
    missing: number[];
    /** Row counts per flag, over the rows returned. */
    counts: Record<SuggestionStatus, number>;
    /** Row counts per recurrence state, over the rows returned. */
    recurrences: Record<SuggestionRecurrence, number>;
  };
}

/**
 * The lean status list: every suggestion in the requested buckets with its flag,
 * oldest bucket first. This is the list an agent reads to find what is still
 * `pending` in a range of buckets without pulling each bucket's full drill-down —
 * the row carries only what it takes to decide and the handle to mark it after.
 *
 * `buckets` omitted means every bucket; `statuses` omitted means all three flags;
 * `recurrences` omitted means all four states. `detail` adds each suggestion's
 * detail, evidence and sources — what a caller about to act on one needs, at the
 * cost of a much larger response.
 */
export async function buildSuggestionStatus(
  logDir: string,
  filter: {
    buckets?: readonly number[];
    statuses?: readonly SuggestionStatus[];
    recurrences?: readonly SuggestionRecurrence[];
    detail?: boolean;
  } = {},
  source: SidecarSource = fileSource,
): Promise<SuggestionStatusResponse> {
  // Only the *derived* half goes through the seam. The status store is authored
  // state, so it stays a JSON file read directly on both sides of parity.
  const [sessions, store] = await Promise.all([source.listSessionGraphs(logDir), readSuggestionStatusStore(logDir)]);
  const buckets = sessionSuggestionBuckets(sessions);
  const existing = buckets.map((b) => b.index).sort((a, b) => a - b);
  const rows = suggestionStatusRows(buckets, store, filter);
  return {
    rows,
    meta: {
      statusFile: resolveSuggestionStatusPath(logDir),
      buckets: existing,
      missing: (filter.buckets ?? []).filter((i) => !existing.includes(i)),
      counts: countSuggestionStatuses(rows),
      recurrences: countSuggestionRecurrences(rows),
    },
  };
}

export interface SuggestionStatusUpdateResponse {
  /** The updated rows, re-read through the same join the list uses. */
  rows: SuggestionStatusRow[];
  meta: { statusFile: string; updated: number; unknown: { bucket: number; id: string }[] };
}

/**
 * Set key for a bucket/id pair. Neither a number nor an id can contain a unit
 * separator, so two equal keys mean a genuinely equal pair.
 */
const suggestionKey = (v: { bucket: number; id: string }): string => `${v.bucket}\u001f${v.id}`;

/**
 * Record flags for suggestions. Every update is applied — a suggestion whose rule
 * has since stopped tripping keeps its flag rather than being dropped, so marking
 * something done is not undone by the next recomputation. Updates naming a
 * bucket/id pair no suggestion currently carries are still written, and reported
 * under `unknown` so a typo is visible instead of silent.
 */
export async function applySuggestionStatus(
  logDir: string,
  updates: readonly SuggestionStatusUpdate[],
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SuggestionStatusUpdateResponse> {
  if (updates.length === 0) throw new Error("no suggestion status updates given");
  const store = await updateSuggestionStatusStore(logDir, updates, now);
  const buckets = sessionSuggestionBuckets(await source.listSessionGraphs(logDir));
  const touched = [...new Set(updates.map((u) => u.bucket))];
  const rows = suggestionStatusRows(buckets, store, { buckets: touched });
  const known = new Set(rows.map((r) => suggestionKey(r)));
  return {
    rows: rows.filter((r) => updates.some((u) => u.bucket === r.bucket && u.id === r.id)),
    meta: {
      statusFile: resolveSuggestionStatusPath(logDir),
      updated: updates.length,
      unknown: updates.filter((u) => !known.has(suggestionKey(u))).map((u) => ({ bucket: u.bucket, id: u.id })),
    },
  };
}

/** One transcript's steps, re-read from the captured request that carries them whole. */
export interface SessionThreadNodes {
  threadId: string;
  /** Sidecar base name of the request the nodes came from — the Request breakdown handle. */
  file: string;
  /** How many messages that request carried, i.e. how deep a snapshot this is. */
  messageCount: number;
  nodes: SessionNode[];
}

export interface SessionGraphNodesResponse {
  rootThreadId: string;
  /** Only the threads a captured request could be found for; the rest keep their transcript. */
  threads: SessionThreadNodes[];
  meta: { files: number; parseErrors: number; requestsRead: number; capped: boolean };
}

/**
 * How many captured requests one family scan will read and parse. Each is a whole request
 * body, so the cap bounds a graph load; the scan is newest-first, so the budget goes to the
 * window the family was active in.
 */
const MAX_FAMILY_REQUESTS = 60;

/**
 * The untruncated step stream for a canvased session and every subagent under it: scan the
 * sidecars carrying the family's session ids newest-first, hash each body back to the thread
 * that produced it, and keep the richest snapshot per thread. Threads with no captured
 * request left go unlisted, and the caller keeps their transcript nodes.
 */
export async function buildSessionGraphNodes(
  logDir: string,
  id: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionGraphNodesResponse> {
  const graphs = await source.listSessionGraphs(logDir);
  const byId = new Map(graphs.map((g) => [g.threadId, g]));
  if (!byId.has(id)) throw new Error(`session not found: ${id}`);

  // The canvased session plus every descendant — one agent family.
  const family = new Set<string>();
  const walk = (threadId: string) => {
    if (family.has(threadId)) return;
    family.add(threadId);
    for (const kid of byId.get(threadId)?.childThreadIds ?? []) walk(kid);
  };
  walk(id);

  const sessionIds = new Set([...family].map((t) => byId.get(t)?.sessionId).filter((s): s is string => !!s));
  if (sessionIds.size === 0) {
    return { rootThreadId: id, threads: [], meta: { files: 0, parseErrors: 0, requestsRead: 0, capped: false } };
  }

  // A family's requests never predate its earliest transcript, and `readSidecars`
  // narrows by *reporting* day, so the floor is derived on that clock too.
  const starts = [...family].map((t) => byId.get(t)?.started).filter((s): s is string => !!s);
  const since = (starts.length > 0 && reportDay(starts.sort()[0]!)) || undefined;

  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { since, includeFile: true }, now);
  const candidates = toContextEntries(sidecars)
    .filter((e) => e.sessionId !== null && sessionIds.has(e.sessionId))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_FAMILY_REQUESTS);

  const best = new Map<string, SessionThreadNodes>();
  let requestsRead = 0;
  for (const entry of candidates) {
    let body: unknown;
    try {
      ({ body } = await readRequestBody(logDir, entry.file));
    } catch {
      continue; // request log rotated away or never landed — the sidecar still counts
    }
    requestsRead += 1;

    const threadId = threadIdForBody(entry.sessionId, (body as { messages?: unknown } | null)?.messages);
    if (!threadId || !family.has(threadId)) continue;

    const messageCount = Array.isArray((body as { messages?: unknown }).messages)
      ? ((body as { messages: unknown[] }).messages.length ?? 0)
      : 0;
    const prev = best.get(threadId);
    if (prev && prev.messageCount >= messageCount) continue;
    best.set(threadId, { threadId, file: entry.file, messageCount, nodes: deriveSessionNodes(body) });
  }

  return {
    rootThreadId: id,
    threads: [...best.values()],
    meta: { files, parseErrors, requestsRead, capped: candidates.length === MAX_FAMILY_REQUESTS },
  };
}

export interface SkimResponse {
  date: string;
  skim: SkimDigest;
  meta: { files: number; parseErrors: number };
}

export async function buildSkim(
  logDir: string,
  date?: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SkimResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await source.readSidecars(
    logDir,
    { date: day, includeSkimRequests: true },
    now,
  );
  const skim = computeSkimDigest(sidecars, { date: day, topN: 50 });
  return { date: day, skim, meta: { files, parseErrors } };
}

export interface SkimTrendResponse {
  digests: SkimDigest[];
  topShapes: SkimShape[];
  meta: { days: number; files: number; parseErrors: number };
}

export async function buildSkimTrend(
  logDir: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SkimTrendResponse> {
  const { sidecars, files, parseErrors } = await source.readSidecars(
    logDir,
    { sinceDays: days, includeSkimRequests: true },
    now,
  );
  const topShapes = computeSkimDigest(sidecars, { date: `${days}d`, topN: 50 }).topShapes;
  return { digests: skimDigestsByDay(sidecars), topShapes, meta: { days, files, parseErrors } };
}

export interface WithheldResponse {
  /** The device settings file the deny-list was read from (device-specific). */
  settingsPath: string;
  settingsReadable: boolean;
  report: WithheldReport;
  /** `claude*` launch aliases from the shell rc, the raw flags each parses, and
   * their net effective tool posture (cross-referencing the device deny list +
   * disable keys). Launch flags never reach the proxy, so this is computed from
   * settings precedence, not verified against traffic like the deny rules. */
  launchAliases: {
    rcPath: string;
    rcReadable: boolean;
    aliases: LaunchAlias[];
    posture: LaunchAliasPosture;
  };
  meta: { days: number; files: number; parseErrors: number };
}

/**
 * The device's withheld-tools policy: which tool schemas `~/.claude/settings.json`
 * keeps out of every request, cross-referenced with the last `days` of traffic
 * so we can confirm each is actually absent. This is a policy/verification view,
 * hence a window rather than a single day. Also surfaces the `claude*` launch
 * aliases from the shell rc, which withhold tools per-launch via
 * `--disallowedTools` (declarative — not traffic-verified).
 */
export async function buildWithheld(
  logDir: string,
  days: number,
  settingsPath: string = resolveSettingsPath(),
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<WithheldResponse> {
  // The traffic half goes through the seam; the device settings and the shell rc
  // are authored files outside `logs/`, read the same way by both backings.
  const [{ sidecars, files, parseErrors }, settings, launchAliases] = await Promise.all([
    source.readSidecars(logDir, { sinceDays: days }, now),
    readDeviceSettings(settingsPath),
    readLaunchAliases(),
  ]);
  const report = withheldReport(sidecars, settings.denyRules, settings.enabledDisableKeys);
  const posture = computeAliasPosture(launchAliases.aliases, settings.denyRules, settings.enabledDisableKeys);
  return {
    settingsPath: settings.settingsPath,
    settingsReadable: settings.readable,
    report,
    launchAliases: { ...launchAliases, posture },
    meta: { days, files, parseErrors },
  };
}

export interface HooksPluginsResponse {
  /** The device settings file the hooks/plugins were read from. */
  settingsPath: string;
  settingsReadable: boolean;
  /** Configured hook commands, flattened from `settings.json` `hooks`. */
  hooks: HookRow[];
  /** Configured plugins, from `settings.json` `enabledPlugins`. */
  plugins: PluginRow[];
  /** Per `claude*` launch alias, whether user hooks/plugins are expected to load. */
  loadExpectations: AliasLoadExpectation[];
  /** The shell rc the launch aliases were read from (for the expectations section). */
  launchRcPath: string;
  launchRcReadable: boolean;
}

/**
 * The device's hooks & plugins configuration inventory, plus which launch modes are
 * expected to load them. Config view, not runtime: hooks have no API footprint, so
 * the proxy can't confirm one fired — only what `~/.claude/settings.json` declares.
 * Load expectations reuse the launch-alias posture.
 */
export async function buildHooksPlugins(
  settingsPath: string = resolveSettingsPath(),
): Promise<HooksPluginsResponse> {
  const [settings, launchAliases] = await Promise.all([readDeviceSettings(settingsPath), readLaunchAliases()]);
  const posture = computeAliasPosture(launchAliases.aliases, settings.denyRules, settings.enabledDisableKeys);
  return {
    settingsPath: settings.settingsPath,
    settingsReadable: settings.readable,
    hooks: flattenHooks(settings.hooks),
    plugins: normalizePlugins(settings.enabledPlugins),
    loadExpectations: hookPluginLoadExpectations(posture),
    launchRcPath: launchAliases.rcPath,
    launchRcReadable: launchAliases.rcReadable,
  };
}

/**
 * The proxy's request-filter inventory: what `proxy/proxy.mjs` strips from every
 * request before forwarding. A static config view — these edits have no
 * per-request variation and can't be configured out of the CLI, so the proxy is
 * the only place they happen. Sourced from `PROXY_FILTER_INVENTORY` in core, which
 * mirrors the proxy's runtime constants.
 */
export function buildFilters(now: Date = new Date()): FiltersResponse {
  return { generatedAt: now.toISOString(), filters: PROXY_FILTER_INVENTORY };
}

export interface CommandsResponse {
  commands: CommandSummary[];
  meta: { commandsDir: string; storePath: string; runs: number; installed: number };
}

/**
 * The `/commands` index. Rows come from the installed catalogue unioned with every
 * command the store has runs for, so a command that a `/sync` removed keeps its history
 * instead of taking it off the page.
 */
export async function buildCommands(
  logDir: string,
  commandsDir: string,
  source: SidecarSource = fileSource,
): Promise<CommandsResponse> {
  const [installed, runs] = await Promise.all([listInstalledCommands(commandsDir), source.readCommandRuns(logDir)]);
  return {
    commands: summarizeCommands(installed, runs),
    meta: {
      commandsDir,
      storePath: `${logDir}/commands/runs.jsonl`,
      runs: runs.length,
      installed: installed.length,
    },
  };
}

/**
 * One run as the command page lists it: everything the scatter and the run list need,
 * without the per-turn series or the per-step breakdown, which only the detail view
 * reads and which dominate a record's size.
 */
export interface CommandRunListItem {
  /** The record's key, and the run route's param — see `runKey`. */
  runId: string;
  /** Set when this run was invoked by another; the row links back to it. */
  parentRunId: string | null;
  parentCommand: string | null;
  threadId: string;
  command: string;
  args: string;
  flags: string[];
  prompt: string;
  commandHash: string | null;
  model: string | null;
  started: string | null;
  ended: string | null;
  outcome: CommandRun["outcome"];
  interruption: CommandRun["interruption"];
  reachedEnd: boolean;
  totals: CommandRun["totals"];
  /** Which rules fired, for the run list's badges. The details stay on the run page. */
  patterns: CommandPattern["id"][];
  /** The furthest declared step anything was attributed to, or null. */
  lastStep: string | null;
  meta: CommandRun["meta"];
}

/** Where the command file's content changed between two consecutive runs — the `/sync` marker. */
export interface CommandHashMarker {
  /** The first run that ran under the new hash. */
  at: string;
  hash: string | null;
  previous: string | null;
}

export interface CommandResponse {
  command: string;
  installed: boolean;
  /** The catalogue as installed now — the spine the funnel and the stacked bar use. */
  steps: CommandStep[];
  commandHash: string | null;
  /** Every flag any run used, for the facet control. Unfiltered by the current facet. */
  flags: string[];
  /** The facet actually applied. */
  appliedFlags: string[];
  runs: CommandRunListItem[];
  stepReach: StepReach[];
  patterns: PatternFrequency[];
  hashMarkers: CommandHashMarker[];
  meta: { totalRuns: number; filteredRuns: number };
}

/**
 * One command's page: its runs as scatter points, the drop-off funnel and stacked
 * tokens-by-step over them, and how often each pattern fires across them.
 *
 * `flags` narrows which runs are aggregated — the facet answers "is `--sub` cheaper than
 * inline?" without splitting the command into per-flag variants, so the flag list and
 * the hash markers are always computed over *all* of the command's runs. Throws a
 * labelled error the server maps to 404 when neither the catalogue nor the store knows
 * the name.
 */
export async function buildCommand(
  logDir: string,
  commandsDir: string,
  command: string,
  flags: readonly string[] = [],
  source: SidecarSource = fileSource,
): Promise<CommandResponse> {
  const [installed, allRuns] = await Promise.all([listInstalledCommands(commandsDir), source.readCommandRuns(logDir)]);
  const spec = installed.find((c) => c.command === command);
  const own = allRuns
    .filter((r) => r.command === command)
    .sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""));
  if (!spec && own.length === 0) throw new Error(`command not found: ${command}`);

  // The current catalogue is the stable spine; fall back to the newest run's snapshot so
  // an uninstalled command still renders against the steps it actually ran under.
  const steps = spec?.steps ?? own[own.length - 1]?.steps ?? [];
  const filtered = filterRunsByFlags(own, flags);

  const markers: CommandHashMarker[] = [];
  let previous: string | null | undefined;
  for (const run of own) {
    const hash = run.commandHash ?? null;
    if (previous !== undefined && hash !== previous && run.started) {
      markers.push({ at: run.started, hash, previous });
    }
    previous = hash;
  }

  return {
    command,
    installed: !!spec,
    steps,
    commandHash: spec?.commandHash ?? null,
    flags: [...new Set(own.flatMap((r) => r.flags ?? []))].sort(),
    appliedFlags: [...flags],
    runs: filtered.map(toListItem).reverse(), // newest first for the list; the scatter re-sorts
    stepReach: stepReach(steps, filtered),
    patterns: patternFrequency(filtered),
    hashMarkers: markers,
    meta: { totalRuns: own.length, filteredRuns: filtered.length },
  };
}

function toListItem(run: CommandRun): CommandRunListItem {
  const reached = (run.stepStats ?? []).filter((s) => s.step !== null && s.reached);
  return {
    runId: runKey(run),
    parentRunId: run.parentRunId ?? null,
    parentCommand: run.parentCommand ?? null,
    threadId: run.threadId,
    command: run.command,
    args: run.args ?? "",
    flags: run.flags ?? [],
    prompt: run.prompt ?? "",
    commandHash: run.commandHash ?? null,
    model: run.model ?? null,
    started: run.started ?? null,
    ended: run.ended ?? null,
    outcome: run.outcome ?? "interrupted",
    interruption: run.interruption ?? null,
    reachedEnd: !!run.reachedEnd,
    totals: runTotals(run),
    patterns: [...new Set((run.patterns ?? []).map((p) => p.id))],
    lastStep: reached[reached.length - 1]?.step ?? null,
    meta: run.meta ?? { turnsUnmapped: 0, nodes: 0, attributed: 0, anchored: 0 },
  };
}

export interface CommandRunResponse {
  run: CommandRun;
  /** How often this run's patterns fire across the rest of the command's runs. */
  patterns: PatternFrequency[];
  /**
   * The existing per-session suggestions covering this run's window, as prose-level
   * diagnosis. Empty once the transcripts behind them have aged out — the run record
   * survives them, and this deliberately does not.
   */
  suggestions: SessionSuggestion[];
  meta: {
    /** Transcripts of this run's family still on disk — the graph can only draw these. */
    transcriptsPresent: number;
    transcripts: number;
    /** True when no captured request survives, so the delta inspector must say so. */
    requestsAgedOut: boolean;
  };
}

/**
 * One run's detail: the full record, its patterns' cross-run frequency, and the
 * suggestions engine's read on the sessions it spans. Throws a labelled error the
 * server maps to 404 when the store has no such run.
 */
export async function buildCommandRun(
  logDir: string,
  runId: string,
  source: SidecarSource = fileSource,
): Promise<CommandRunResponse> {
  const runs = await source.readCommandRuns(logDir);
  // By run id, so a nested run resolves rather than its host answering for it. A
  // top-level run's id *is* its thread id, so old links keep working.
  const run = runs.find((r) => runKey(r) === runId);
  if (!run) throw new Error(`command run not found: ${runId}`);

  const family = new Set(run.threadIds ?? [run.threadId]);
  const sessions = await source.listSessionGraphs(logDir);
  const present = sessions.filter((s) => family.has(s.threadId));
  const buckets = present.length === 0 ? [] : sessionSuggestionBuckets(sessions);

  return {
    run,
    patterns: patternFrequency(runs.filter((r) => r.command === run.command)),
    suggestions: buckets
      .filter((b) => b.threadIds.some((id) => family.has(id)))
      .flatMap((b) => b.suggestions),
    meta: {
      transcriptsPresent: present.length,
      transcripts: family.size,
      requestsAgedOut: (run.turns ?? []).length === 0,
    },
  };
}
