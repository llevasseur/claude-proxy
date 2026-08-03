import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { API_BASE } from './api';

/** SSE connection state, surfaced for a "Live" indicator. */
export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribe to an SSE endpoint and mirror every `snapshot`/`update` frame into the
 * React Query cache under `queryKey`, so any `useQuery(queryKey)` re-renders live
 * without polling. The paired one-shot query still runs, providing the initial value
 * and a fallback: when SSE is unavailable the status is `offline` and that query stays
 * in charge. Returns the current connection status.
 *
 * `enabled: false` skips the subscription, for an id the stream does not know yet.
 */
export function useLiveQuery<T>(path: string, queryKey: QueryKey, enabled = true): LiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  // Stable dep for the (array) query key without re-subscribing on every render.
  const keyId = JSON.stringify(queryKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `keyId` is the stable stringification of `queryKey`, deliberately standing in for it so a fresh array identity does not re-subscribe on every render
  useEffect(() => {
    if (!enabled) {
      setStatus('connecting');
      return;
    }
    if (typeof EventSource === 'undefined') {
      setStatus('offline');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(`${API_BASE}${path}`);

    const apply = (ev: MessageEvent) => {
      try {
        queryClient.setQueryData<T>(queryKey, JSON.parse(ev.data) as T);
        setStatus('live');
      } catch {
        /* ignore a malformed frame — the next one re-syncs */
      }
    };
    es.addEventListener('snapshot', apply as EventListener);
    es.addEventListener('update', apply as EventListener);
    es.onopen = () => setStatus('live');
    // EventSource retries on transient errors; a closed stream (bad id, 404) won't.
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');

    return () => es.close();
  }, [path, keyId, queryClient, enabled]);

  return status;
}
