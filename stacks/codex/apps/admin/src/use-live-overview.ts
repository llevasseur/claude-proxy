import type { TodaySummary } from '@agent-proxy/codex-core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getHealth, getSummary, healthKey, isLiveSnapshot, type LiveSnapshot, summaryKey } from './api.ts';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export function useLiveOverview() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: healthKey, queryFn: getHealth });
  const summary = useQuery({ queryKey: summaryKey, queryFn: getSummary });
  const [stream, setStream] = useState<StreamState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/events');
    let received = false;

    source.onopen = () => setStream(received ? 'live' : 'connecting');
    const receive = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isLiveSnapshot(parsed)) return;
      const snapshot: LiveSnapshot = parsed;
      received = true;
      queryClient.setQueryData(healthKey, snapshot.health);
      queryClient.setQueryData<TodaySummary>(summaryKey, snapshot.summary);
      setLastEventAt(new Date().toISOString());
      setStream('live');
    };

    source.addEventListener('snapshot', receive as EventListener);
    source.addEventListener('update', receive as EventListener);
    source.onerror = () => {
      const hasLastKnown = queryClient.getQueryData(summaryKey) !== undefined;
      setStream(hasLastKnown ? 'reconnecting' : 'offline');
    };

    return () => source.close();
  }, [queryClient]);

  return { health, summary, stream, lastEventAt };
}
