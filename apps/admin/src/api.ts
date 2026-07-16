import type { Advice, TopTool, UsageDigest } from "@claude-proxy/core";

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
