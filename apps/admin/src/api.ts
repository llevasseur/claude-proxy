import type {
  Advice,
  ContextSummary,
  LaunchAlias,
  RequestBreakdown,
  RequestMessageDetail,
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
  meta: { days: number; files: number; parseErrors: number };
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
  launchAliases: { rcPath: string; rcReadable: boolean; aliases: LaunchAlias[] };
  meta: { days: number; files: number; parseErrors: number };
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
export const getSkim = (date?: string) => get<SkimResponse>(`/api/skim${qs(date)}`);
export const getSkimTrend = (days: number) => get<SkimTrendResponse>(`/api/skim/trend?days=${days}`);
export const getWithheld = (days = 14) => get<WithheldResponse>(`/api/withheld?days=${days}`);
