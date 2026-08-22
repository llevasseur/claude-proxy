import { useSyncExternalStore } from 'react';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface DataVersionSnapshot {
  readonly version: number | null;
  readonly stream: StreamState;
}

let snapshot: DataVersionSnapshot = { version: null, stream: 'connecting' };
let source: EventSource | null = null;
let refCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function patch(next: Partial<DataVersionSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  emit();
}

function parseVersion(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : null;
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      return typeof version === 'number' && Number.isFinite(version) ? version : null;
    }
    return null;
  } catch {
    const direct = Number(raw);
    return raw !== '' && Number.isFinite(direct) ? direct : null;
  }
}

function ensureSource(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => patch({ stream: 'live' });
  source.addEventListener('data-version', (event) => {
    const version = parseVersion((event as MessageEvent<string>).data);
    if (version !== null) patch({ version });
  });
  source.onerror = () => patch({ stream: 'reconnecting' });
}

function releaseSource(): void {
  source?.close();
  source = null;
}

function subscribe(listener: () => void): () => void {
  refCount += 1;
  ensureSource();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    refCount -= 1;
    if (refCount === 0) releaseSource();
  };
}

function getSnapshot(): DataVersionSnapshot {
  return snapshot;
}

export function useDataVersionSignal(): DataVersionSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function streamStatusText(state: StreamState, hasData: boolean): string {
  if (state === 'live') return 'Live';
  if (state === 'connecting') return 'Connecting…';
  if (state === 'reconnecting') {
    return hasData ? 'Reconnecting · showing last known data' : 'Reconnecting…';
  }
  return hasData ? 'Offline · showing last known data' : 'Offline';
}
