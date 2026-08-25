import type { TodaySummary } from '@agent-proxy/codex-core';

export interface HealthResponse {
  readonly ready: boolean;
  readonly server: Readonly<{ status: 'ready' | 'starting'; startedAt: string | null }>;
  readonly proxy: Readonly<{
    status: 'healthy' | 'degraded' | 'unavailable';
    state: 'starting' | 'ready' | 'upstream-error' | 'shutdown' | null;
    updatedAt: string | null;
  }>;
  readonly database: Readonly<{
    status: 'ready';
    path: string;
    schemaVersion: number;
    journalMode: string;
    recordCount: number;
  }>;
  readonly ingest: Readonly<{ lastSuccessfulAt: string | null; rejectedSidecars: number }>;
  readonly sse: Readonly<{ subscribers: number }>;
}

export interface LiveSnapshot {
  readonly health: HealthResponse;
  readonly summary: TodaySummary;
}

export const healthKey = ['health'] as const;
export const summaryKey = ['summary'] as const;

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return getJson('/api/health');
}

export function getSummary(): Promise<TodaySummary> {
  return getJson('/api/summary');
}

export function isLiveSnapshot(value: unknown): value is LiveSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.health === 'object' && snapshot.health !== null && typeof snapshot.summary === 'object';
}
