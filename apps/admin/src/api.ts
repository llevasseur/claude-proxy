import type {
  Advice,
  AliasLoadExpectation,
  BucketBreakdownSummary,
  ContextSummary,
  HookRow,
  JobFileKind,
  JobStateFields,
  JobTreeNode,
  LaunchAlias,
  LaunchAliasPosture,
  PluginRow,
  ProxyFilterEntry,
  RequestBreakdown,
  RequestMessageDetail,
  RequestToolDetail,
  SessionAgentLink,
  SessionBucket,
  SessionContextPeak,
  SessionError,
  SessionMeta,
  SessionNode,
  SessionSuggestion,
  SkimDigest,
  SkimShape,
  SuggestionStatus,
  SuggestionStatusRow,
  SuggestionStatusUpdate,
  TopTool,
  UsageDigest,
  WithheldReport,
} from "@claude-proxy/core";

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8788";

// HTTP envelopes — mirror the shapes returned by the server package.
export interface SummaryResponse {
  digest: UsageDigest;
  advice: Advice[];
  meta: { date: string; files: number; parseErrors: number };
}
export interface TrendsResponse {
  digests: UsageDigest[];
  meta: { days: number; files: number; parseErrors: number; archivedDays: number };
}
export interface ToolsResponse {
  date: string;
  topTools: TopTool[];
  meta: { files: number; parseErrors: number };
}
export interface ContextResponse {
  summary: ContextSummary;
  meta: { days: number; files: number; parseErrors: number };
}
export interface ContextDetailResponse {
  file: string;
  breakdown: RequestBreakdown;
  raw: string;
  truncated: boolean;
}
export interface ContextMessageResponse {
  file: string;
  message: RequestMessageDetail;
}
export interface ContextToolResponse {
  file: string;
  tool: RequestToolDetail;
}
export interface SkimResponse {
  date: string;
  skim: SkimDigest;
  meta: { files: number; parseErrors: number };
}
export interface SkimTrendResponse {
  digests: SkimDigest[];
  topShapes: SkimShape[];
  meta: { days: number; files: number; parseErrors: number };
}
export interface WithheldResponse {
  settingsPath: string;
  settingsReadable: boolean;
  report: WithheldReport;
  launchAliases: { rcPath: string; rcReadable: boolean; aliases: LaunchAlias[]; posture: LaunchAliasPosture };
  meta: { days: number; files: number; parseErrors: number };
}
export interface ProjectSummary {
  name: string;
  memoryCount: number;
}
export interface ProjectsResponse {
  projects: ProjectSummary[];
  meta: { projectsDir: string; total: number };
}
export interface MemoryFileSummary {
  name: string;
  bytes: number;
  modified: string;
}
export interface ProjectMemoriesResponse {
  project: string;
  files: MemoryFileSummary[];
  meta: { total: number };
}
export interface MemoryDetail {
  project: string;
  name: string;
  content: string;
  bytes: number;
  modified: string;
}
export interface MemoryResponse {
  memory: MemoryDetail;
}
export interface HooksPluginsResponse {
  settingsPath: string;
  settingsReadable: boolean;
  hooks: HookRow[];
  plugins: PluginRow[];
  loadExpectations: AliasLoadExpectation[];
  launchRcPath: string;
  launchRcReadable: boolean;
}
/** One `~/.claude/jobs/<id>` directory: what its state file says plus what it holds. */
export interface JobSummary extends JobStateFields {
  id: string;
  stateReadable: boolean;
  files: number;
  bytes: number;
  modified: string;
  /** Newest of `updatedAt` and `modified` — what the listing sorts by. */
  activity: string;
}
export interface JobsResponse {
  jobs: JobSummary[];
  meta: { jobsDir: string; total: number; running: number; husks: number; files: number; bytes: number };
}
export interface JobResponse {
  job: JobSummary;
  tree: JobTreeNode[];
  meta: { entries: number; truncated: boolean };
}
/** One file inside a job directory, as the pretty/raw viewer receives it. */
export interface JobFileDetail {
  id: string;
  path: string;
  name: string;
  kind: JobFileKind;
  bytes: number;
  modified: string;
  encoding: "utf8" | "base64";
  content: string;
  mime: string | null;
  truncated: boolean;
  binary: boolean;
  note: string | null;
}
export interface JobFileResponse {
  file: JobFileDetail;
}
export interface SessionSummary extends SessionMeta {
  bytes: number;
  modified: string;
}
export interface SessionsResponse {
  sessions: SessionSummary[];
  meta: { sessionsDir: string; total: number };
}
/** A transcript's steps plus its place in the session's agent tree (parent/subagent links). */
export interface SessionGraphEntry extends SessionSummary, SessionAgentLink {
  nodes: SessionNode[];
}
export interface SessionsGraphResponse {
  sessions: SessionGraphEntry[];
  meta: { sessionsDir: string; total: number };
}
/** Node index → the whole text behind that step's truncated one-line gist. Sparse. */
export interface SessionNodeTextsResponse {
  threadId: string;
  texts: Record<number, string>;
}
/** One transcript's steps re-derived from the captured request that holds them untruncated. */
export interface SessionThreadNodes {
  threadId: string;
  /** Sidecar base name of the request the nodes came from — the Request breakdown handle. */
  file: string;
  messageCount: number;
  nodes: SessionNode[];
}
export interface SessionGraphNodesResponse {
  rootThreadId: string;
  threads: SessionThreadNodes[];
  meta: { files: number; parseErrors: number; requestsRead: number; capped: boolean };
}
export interface SessionDetail {
  meta: SessionMeta;
  content: string;
  bytes: number;
  modified: string;
}
export interface SessionResponse {
  session: SessionDetail;
}
export interface SessionErrorsResponse {
  threadId: string;
  meta: SessionMeta;
  errors: SessionError[];
}
/** The session's largest captured request — the handle for its Request breakdown page. */
export interface SessionBreakdownResponse extends SessionContextPeak {
  threadId: string;
  sessionId: string | null;
  meta: { files: number; parseErrors: number };
}
/** Every ten-session window with its suggestions, newest bucket first. */
export interface SessionSuggestionsResponse {
  buckets: SessionBucket[];
  meta: { sessionsDir: string; sessions: number; buckets: number };
}
/** One bucket's drill-down: its suggestions, its sessions, and the request patterns behind them. */
export interface SessionSuggestionBucketResponse {
  bucket: SessionBucket;
  sessions: SessionSummary[];
  breakdown: BucketBreakdownSummary;
  breakdownSuggestions: SessionSuggestion[];
  meta: { files: number; parseErrors: number; requestsMissing: number };
}
/** Every suggestion in the requested buckets with its flag, oldest bucket first. */
export interface SuggestionStatusResponse {
  rows: SuggestionStatusRow[];
  meta: {
    statusFile: string;
    buckets: number[];
    missing: number[];
    counts: Record<SuggestionStatus, number>;
  };
}
/** The rows a write touched, re-read through the same join the list uses. */
export interface SuggestionStatusUpdateResponse {
  rows: SuggestionStatusRow[];
  meta: { statusFile: string; updated: number; unknown: { bucket: number; id: string }[] };
}
export interface FiltersResponse {
  generatedAt: string;
  filters: ProxyFilterEntry[];
}
/** `agent` runs a real Claude Code session and can change the repo; `chat` cannot. */
export type ChatMode = "chat" | "agent";
/**
 * The standing answer an agent turn's headless child gives to permission prompts.
 * Mirrors `PERMISSION_MODES` in `server/src/chat.ts`; the server rejects anything else.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** What an agent turn inherits from the device, for the posture line in the UI. */
export interface ChatAgentConfig {
  cwd: string;
  alias: string;
  aliasFound: boolean;
  rcPath: string;
  rcReadable: boolean;
  flags: { disallowedTools: string[]; settingSources: string[] | null; settingsOverrides: Record<string, unknown> | null };
  permissionMode: string;
}
/** The resolved settings a dashboard-started chat runs with. */
export interface ChatConfigResponse {
  transport: "cli" | "api";
  mode: ChatMode;
  agent: ChatAgentConfig | null;
  baseUrl: string;
  model: string;
  maxTokens: number;
  system: string;
  anthropicVersion: string;
  beta: string | null;
  apiKeySet: boolean;
  cliPath: string;
  cliFound: string | null;
  ready: boolean;
  readyHint: string | null;
}
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}
/** One tool an agent turn ran. */
export interface ChatToolUse {
  name: string;
  failed: boolean;
  /** Why it failed, from its `tool_result` — a permission denial says so here. */
  error?: string;
}
/** Why a turn ended early: `timeout` is going quiet, `limit` is outrunning the ceiling. */
export type ChatInterruption = "stopped" | "timeout" | "limit";
/** A chat whose turn is in flight right now, as the server sees it. */
export interface RunningChat {
  /** Also the `session:` a transcript records, which is how a session page matches itself. */
  sessionId: string;
  threadId: string | null;
  mode: ChatMode;
  permissionMode: string | null;
  effectivePermissionMode: string | null;
  startedAt: string;
}
export interface RunningChatsResponse {
  running: RunningChat[];
}
/** The transcript a chat session id became; `threadId` is null until the proxy has written it. */
export interface ChatThreadResponse {
  sessionId: string;
  threadId: string | null;
}
export interface ChatSendResponse {
  session: {
    id: string;
    threadId: string | null;
    model: string;
    createdAt: string;
    transport: "cli" | "api";
    mode: ChatMode;
    permissionMode: string | null;
    /** What the child reported it started under; a mismatch means the pin never landed. */
    effectivePermissionMode: string | null;
  };
  reply: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  turns: ChatTurn[];
  tools: ChatToolUse[];
  /** Set when the turn was stopped, went quiet, or hit its ceiling; the reply is the partial one. */
  interrupted: ChatInterruption | null;
}
export interface HealthResponse {
  ok: boolean;
  logDir: string;
  logDirReadable: boolean;
  sidecarCount: number | null;
}

/** Unwrap a response, preferring the server's `{ error }` message over the status. */
async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(`${API_BASE}${path}`));
}

/** The chat routes and the suggestion flags are the only writes the API accepts. */
async function post<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const qs = (date?: string) => (date ? `?date=${encodeURIComponent(date)}` : "");

export const getHealth = () => get<HealthResponse>("/api/health");
export const getSummary = (date?: string) => get<SummaryResponse>(`/api/summary${qs(date)}`);
export const getTrends = (days: number) => get<TrendsResponse>(`/api/trends?days=${days}`);
export const getTools = (date?: string) => get<ToolsResponse>(`/api/tools${qs(date)}`);
export const getContext = (days: number) => get<ContextResponse>(`/api/context?days=${days}`);
export const getContextDetail = (file: string) =>
  get<ContextDetailResponse>(`/api/context/detail?file=${encodeURIComponent(file)}`);
export const getContextMessage = (file: string, index: number) =>
  get<ContextMessageResponse>(`/api/context/message?file=${encodeURIComponent(file)}&index=${index}`);
export const getContextTool = (file: string, index: number) =>
  get<ContextToolResponse>(`/api/context/tool?file=${encodeURIComponent(file)}&index=${index}`);
export const getProjects = () => get<ProjectsResponse>("/api/projects");
export const getProjectMemories = (project: string) =>
  get<ProjectMemoriesResponse>(`/api/projects/memories?project=${encodeURIComponent(project)}`);
export const getMemory = (project: string, name: string) =>
  get<MemoryResponse>(`/api/projects/memory?project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`);
/** Every background job directory on the device, newest activity first. */
export const getJobs = () => get<JobsResponse>("/api/jobs");
export const getJob = (id: string) => get<JobResponse>(`/api/jobs/job?id=${encodeURIComponent(id)}`);
/** One file from a job directory — `file` is a path relative to that directory. */
export const getJobFile = (id: string, file: string) =>
  get<JobFileResponse>(`/api/jobs/file?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`);
export const getSessions = () => get<SessionsResponse>("/api/sessions");
export const getSessionsGraph = () => get<SessionsGraphResponse>("/api/sessions/graph");
export const getSessionGraphNodes = (id: string) =>
  get<SessionGraphNodesResponse>(`/api/sessions/graph/nodes?id=${encodeURIComponent(id)}`);
export const getSession = (id: string) =>
  get<SessionResponse>(`/api/sessions/session?id=${encodeURIComponent(id)}`);
export const getSessionErrors = (id: string) =>
  get<SessionErrorsResponse>(`/api/sessions/errors?id=${encodeURIComponent(id)}`);
export const getSessionNodeTexts = (id: string) =>
  get<SessionNodeTextsResponse>(`/api/sessions/node-text?id=${encodeURIComponent(id)}`);
export const getSessionBreakdown = (id: string) =>
  get<SessionBreakdownResponse>(`/api/sessions/breakdown?id=${encodeURIComponent(id)}`);
/** Every ten-session window, recomputed server-side on each load — this is the backfill. */
export const getSessionSuggestions = () => get<SessionSuggestionsResponse>("/api/sessions/suggestions");
export const getSessionSuggestionBucket = (index: number) =>
  get<SessionSuggestionBucketResponse>(`/api/sessions/suggestions/bucket?index=${index}`);
/** The flags on those suggestions. `range` narrows to a bucket, list or span. */
export const getSuggestionStatus = (opts: { range?: string; statuses?: SuggestionStatus[]; detail?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (opts.range) params.set("range", opts.range);
  if (opts.statuses?.length) params.set("status", opts.statuses.join(","));
  if (opts.detail) params.set("detail", "1");
  const query = params.toString();
  return get<SuggestionStatusResponse>(`/api/sessions/suggestions/status${query ? `?${query}` : ""}`);
};
/** Record flags. Setting one back to `pending` deletes its entry — that is the undo. */
export const markSuggestionStatus = (updates: SuggestionStatusUpdate[]) =>
  post<SuggestionStatusUpdateResponse>("/api/sessions/suggestions/status", { updates });
export const getSkim = (date?: string) => get<SkimResponse>(`/api/skim${qs(date)}`);
export const getSkimTrend = (days: number) => get<SkimTrendResponse>(`/api/skim/trend?days=${days}`);
export const getWithheld = (days = 14) => get<WithheldResponse>(`/api/withheld?days=${days}`);
export const getHooksPlugins = () => get<HooksPluginsResponse>("/api/hooks-plugins");
export const getFilters = () => get<FiltersResponse>("/api/filters");
export const getChatConfig = () => get<ChatConfigResponse>("/api/chat/config");
/** Turns in flight — how a session page finds the Stop the starting tab may have lost. */
export const getRunningChats = () => get<RunningChatsResponse>("/api/chat/running");
/** Which transcript a chat session id became — polled by the page it navigated to. */
export const getChatThread = (sessionId: string) =>
  get<ChatThreadResponse>(`/api/chat/thread?sessionId=${encodeURIComponent(sessionId)}`);
/** The session id is chosen here, not read off the response, so the first turn is stoppable. */
export const startChat = (
  sessionId: string,
  prompt: string,
  opts: { mode?: ChatMode; permissionMode?: PermissionMode } = {},
) => post<ChatSendResponse>("/api/chat/sessions", { sessionId, prompt, ...opts });
export const sendChatMessage = (sessionId: string, prompt: string) =>
  post<ChatSendResponse>("/api/chat/sessions/message", { sessionId, prompt });
/** Ends the turn in flight; the send it interrupts resolves with the partial reply. */
export const stopChat = (sessionId: string) =>
  post<{ sessionId: string; stopped: boolean }>("/api/chat/stop", { sessionId });
/** Ends the session, so the server stops holding it once the user moves on. */
export const endChat = (sessionId: string) =>
  post<{ sessionId: string; stopped: boolean }>("/api/chat/sessions/end", { sessionId });
