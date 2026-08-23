import { useSyncExternalStore } from "react";

// Data-version SSE signal ported from codex-proxy
// `apps/admin/src/car/stream.ts`; frames carry { dataVersion } per ADR 0012.

export type StreamState = "connecting" | "live" | "reconnecting";

export interface DataVersionSnapshot {
  readonly version: number | null;
  readonly stream: StreamState;
}

let snapshot: DataVersionSnapshot = { version: null, stream: "connecting" };
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
    if (typeof parsed === "object" && parsed !== null && "dataVersion" in parsed) {
      const version = (parsed as { dataVersion: unknown }).dataVersion;
      return typeof version === "number" && Number.isFinite(version) ? version : null;
    }
    return null;
  } catch {
    return null;
  }
}

function ensureSource(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.addEventListener("open", () => patch({ stream: "live" }));
  source.addEventListener("data-version", (event) => {
    const version = parseVersion((event as MessageEvent<string>).data);
    if (version !== null) patch({ version });
  });
  source.addEventListener("error", () => patch({ stream: "reconnecting" }));
}

function releaseSource(): void {
  source?.close();
  source = null;
  // A remounted route builds a fresh EventSource; leaving the last state here
  // would render "Live" until its `open` fires.
  patch({ version: null, stream: "connecting" });
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
  if (state === "live") return "Live";
  if (state === "connecting") return "Connecting…";
  return hasData ? "Reconnecting · showing last known data" : "Reconnecting…";
}
