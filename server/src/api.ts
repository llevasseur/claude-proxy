import {
  analyzeRequestBody,
  computeDigest,
  extractRequestMessage,
  extractRequestTool,
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
  parseSessionErrors,
  sessionContextPeak,
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
  type SessionContextPeak,
  type SessionError,
  type SessionMeta,
  type SkimDigest,
  type SkimShape,
  type TopTool,
  type UsageDigest,
  type WithheldReport,
  PROXY_FILTER_INVENTORY,
  type FiltersResponse,
} from "@claude-proxy/core";
import { loadArchivedDigest } from "./archive.js";
import { readArchivedDay, readRequestBody, readSidecars, shiftDay, today } from "./logs.js";
import {
  listProjectMemories,
  listProjects,
  readMemory,
  type MemoryDetail,
  type MemoryFileSummary,
  type ProjectSummary,
} from "./projects.js";
import {
  listSessionGraphs,
  listSessions,
  readSession,
  type SessionDetail,
  type SessionGraph,
  type SessionSummary,
} from "./sessions.js";
import { readDeviceSettings, resolveSettingsPath } from "./settings.js";
import { readLaunchAliases } from "./shell-rc.js";

export interface SummaryResponse {
  digest: UsageDigest;
  advice: Advice[];
  meta: { date: string; files: number; parseErrors: number };
}

/** One day's digest + advice, with the trend computed against the prior day. */
export async function buildSummary(logDir: string, date?: string, now: Date = new Date()): Promise<SummaryResponse> {
  const day = date ?? today(now);
  const prevDay = shiftDay(day, -1);
  const [cur, prev] = await Promise.all([
    readSidecars(logDir, { date: day }, now),
    readSidecars(logDir, { date: prevDay }, now),
  ]);
  const priorDigest = computeDigest(prev.sidecars, { date: prevDay });
  const digest = computeDigest(cur.sidecars, { date: day, priorDigest });
  const advice = await heuristicAdvice.advise(digest);
  return { digest, advice, meta: { date: day, files: cur.files, parseErrors: cur.parseErrors } };
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
async function rawArchivedDigest(logDir: string, date: string): Promise<UsageDigest | null> {
  const key = `${logDir} ${date}`;
  const hit = rawArchiveDigests.get(key);
  if (hit) return hit;

  const { sidecars, files } = await readArchivedDay(logDir, date);
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
): Promise<TrendsResponse> {
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { sinceDays: days }, now);
  const byDate = new Map<string, UsageDigest>();
  for (const d of digestsByDay(sidecars)) byDate.set(d.date, d);

  let archivedDays = 0;
  const end = today(now);
  for (let i = 0; i < days; i += 1) {
    const date = shiftDay(end, -i);
    if (byDate.has(date)) continue;
    const digest =
      (await rawArchivedDigest(logDir, date)) ?? (archiveDir ? await loadArchivedDigest(archiveDir, date) : null);
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
export async function buildTools(logDir: string, date?: string, now: Date = new Date()): Promise<ToolsResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { date: day }, now);
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
export async function buildContext(logDir: string, days: number, now: Date = new Date()): Promise<ContextResponse> {
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { sinceDays: days, includeFile: true }, now);
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

export interface SessionsResponse {
  sessions: SessionSummary[];
  meta: { sessionsDir: string; total: number };
}

/** Every session transcript the proxy has written, newest first. */
export async function buildSessions(logDir: string): Promise<SessionsResponse> {
  const sessions = await listSessions(logDir);
  return { sessions, meta: { sessionsDir: `${logDir}/sessions`, total: sessions.length } };
}

export interface SessionsGraphResponse {
  sessions: SessionGraph[];
  meta: { sessionsDir: string; total: number };
}

/** Every session transcript with its structured node stream, newest first — feeds the live graph. */
export async function buildSessionsGraph(logDir: string): Promise<SessionsGraphResponse> {
  const sessions = await listSessionGraphs(logDir);
  return { sessions, meta: { sessionsDir: `${logDir}/sessions`, total: sessions.length } };
}

export interface SessionResponse {
  session: SessionDetail;
}

/** One session transcript's full contents. `id` is validated downstream. */
export async function buildSession(logDir: string, id: string): Promise<SessionResponse> {
  return { session: await readSession(logDir, id) };
}

export interface SessionErrorsResponse {
  threadId: string;
  meta: SessionMeta;
  errors: SessionError[];
}

/**
 * Every errored tool result in one session, re-linked to its task and tool call.
 * Reuses {@link readSession}, which validates `id` and maps to 400/404.
 */
export async function buildSessionErrors(logDir: string, id: string): Promise<SessionErrorsResponse> {
  const { meta, content } = await readSession(logDir, id);
  return { threadId: id, meta, errors: parseSessionErrors(content) };
}

export interface SessionBreakdownResponse extends SessionContextPeak {
  threadId: string;
  /** The Claude Code session id the requests were matched on; null if the transcript has none. */
  sessionId: string | null;
  meta: { files: number; parseErrors: number };
}

/**
 * The captured request a session links to for its breakdown: the largest one sent
 * under its session id. Scans sidecars from the session's start date onward — a
 * session's requests never predate it — or the whole log when it has no start.
 */
export async function buildSessionBreakdown(
  logDir: string,
  id: string,
  now: Date = new Date(),
): Promise<SessionBreakdownResponse> {
  const { meta } = await readSession(logDir, id);
  const sessionId = meta.sessionId;
  if (!sessionId) {
    return { threadId: id, sessionId: null, requestCount: 0, peak: null, meta: { files: 0, parseErrors: 0 } };
  }

  const since = meta.started ? meta.started.slice(0, 10) : undefined;
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { since, includeFile: true }, now);
  const entries = toContextEntries(sidecars);

  return { threadId: id, sessionId, ...sessionContextPeak(entries, sessionId), meta: { files, parseErrors } };
}

export interface SkimResponse {
  date: string;
  skim: SkimDigest;
  meta: { files: number; parseErrors: number };
}

export async function buildSkim(logDir: string, date?: string, now: Date = new Date()): Promise<SkimResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { date: day, includeSkimRequests: true }, now);
  const skim = computeSkimDigest(sidecars, { date: day, topN: 50 });
  return { date: day, skim, meta: { files, parseErrors } };
}

export interface SkimTrendResponse {
  digests: SkimDigest[];
  topShapes: SkimShape[];
  meta: { days: number; files: number; parseErrors: number };
}

export async function buildSkimTrend(logDir: string, days: number, now: Date = new Date()): Promise<SkimTrendResponse> {
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { sinceDays: days, includeSkimRequests: true }, now);
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
): Promise<WithheldResponse> {
  const [{ sidecars, files, parseErrors }, settings, launchAliases] = await Promise.all([
    readSidecars(logDir, { sinceDays: days }, now),
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
