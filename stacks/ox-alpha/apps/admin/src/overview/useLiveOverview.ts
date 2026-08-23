import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { fetchHealth, fetchSummary, type HealthPayload, parseHealth, parseSummary, type SummaryPayload } from '../api';
import { type ConnectionStatus, computeConnectionStatus } from './machine';

const REFETCH_BACKSTOP_MS = 10_000;
const TICK_MS = 1_000;

export interface LiveOverview {
  readonly status: ConnectionStatus;
  readonly health: HealthPayload | null;
  readonly summary: SummaryPayload | null;
}

// Bootstraps from /api/health and /api/summary, subscribes to /api/events
// SSE, and keeps a periodic refetch backstop. Every signal only updates the
// retained snapshot in place; nothing here clears it, so the shell and last
// known values survive reconnecting, stale, degraded, and unavailable states
// without a reload.
export function useLiveOverview(): LiveOverview {
  const queryClient = useQueryClient();
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [sseOpen, setSseOpen] = useState(false);
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // A successful signal of any kind proves the server is reachable again.
  const markReachable = useCallback(() => {
    setBootstrapFailed(false);
    setLastSignalAt(Date.now());
  }, []);

  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      try {
        const health = await fetchHealth();
        markReachable();
        return health;
      } catch (error) {
        setBootstrapFailed(true);
        throw error;
      }
    },
    refetchInterval: REFETCH_BACKSTOP_MS,
    retry: false,
  });

  const summaryQuery = useQuery({
    queryKey: ['summary'],
    queryFn: async () => {
      try {
        const summary = await fetchSummary();
        markReachable();
        return summary;
      } catch {
        return null;
      }
    },
    refetchInterval: REFETCH_BACKSTOP_MS,
    retry: false,
  });

  useEffect(() => {
    const source = new EventSource('/api/events');
    const applySnapshot = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (typeof parsed !== 'object' || parsed === null) return;
        const { health, summary } = parsed as Record<string, unknown>;
        if (health !== undefined) queryClient.setQueryData(['health'], parseHealth(health));
        if (summary !== undefined) {
          queryClient.setQueryData(['summary'], parseSummary(summary));
        }
        markReachable();
        setSseOpen(true);
      } catch {
        // A malformed frame is dropped; the next keepalive or refetch recovers.
      }
    };
    source.addEventListener('snapshot', applySnapshot as EventListener);
    source.addEventListener('update', applySnapshot as EventListener);
    source.addEventListener('open', () => setSseOpen(true));
    source.addEventListener('error', () => {
      // The browser retries automatically; while it does, we are reconnecting.
      setSseOpen(source.readyState === EventSource.OPEN);
    });
    return () => source.close();
  }, [queryClient, markReachable]);

  const status = computeConnectionStatus({
    bootstrapFailed,
    hasSnapshot: healthQuery.data !== undefined || summaryQuery.data != null,
    sseOpen,
    lastSignalAgeMs: lastSignalAt === null ? null : now - lastSignalAt,
    proxyStatus: healthQuery.data?.proxy.status ?? null,
  });
  return {
    status,
    health: healthQuery.data ?? null,
    summary: summaryQuery.data ?? null,
  };
}
