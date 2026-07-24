import type {
  Advice,
  AliasLoadExpectation,
  ContextSummary,
  HookRow,
  LaunchAlias,
  LaunchAliasPosture,
  PluginRow,
  ProxyFilterEntry,
  RequestBreakdown,
  RequestMessageDetail,
  RequestToolDetail,
  SessionError,
  SessionMeta,
  SessionNode,
  SkimDigest,
  SkimShape,
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
export interface SessionSummary extends SessionMeta {
  bytes: number;
  modified: string;
}
export interface SessionsResponse {
  sessions: SessionSummary[];
  meta: { sessionsDir: string; total: number };
}
export interface SessionGraphEntry extends SessionSummary {
  nodes: SessionNode[];
}
export interface SessionsGraphResponse {
  sessions: SessionGraphEntry[];
  meta: { sessionsDir: string; total: number };
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
export interface FiltersResponse {
  generatedAt: string;
  filters: ProxyFilterEntry[];
}
export interface HealthResponse {
  ok: boolean;
  logDir: string;
  logDirReadable: boolean;
  sidecarCount: number | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
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
export const getSessions = () => get<SessionsResponse>("/api/sessions");
export const getSessionsGraph = () => get<SessionsGraphResponse>("/api/sessions/graph");
export const getSession = (id: string) =>
  get<SessionResponse>(`/api/sessions/session?id=${encodeURIComponent(id)}`);
export const getSessionErrors = (id: string) =>
  get<SessionErrorsResponse>(`/api/sessions/errors?id=${encodeURIComponent(id)}`);
export const getSkim = (date?: string) => get<SkimResponse>(`/api/skim${qs(date)}`);
export const getSkimTrend = (days: number) => get<SkimTrendResponse>(`/api/skim/trend?days=${days}`);
export const getWithheld = (days = 14) => get<WithheldResponse>(`/api/withheld?days=${days}`);
export const getHooksPlugins = () => get<HooksPluginsResponse>("/api/hooks-plugins");
export const getFilters = () => get<FiltersResponse>("/api/filters");
