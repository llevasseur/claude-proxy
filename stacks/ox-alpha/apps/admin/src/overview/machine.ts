export type ConnectionStatus =
  | "bootstrapping"
  | "live"
  | "reconnecting"
  | "stale"
  | "degraded"
  | "unavailable";

export interface ConnectionInput {
  readonly bootstrapFailed: boolean;
  readonly hasSnapshot: boolean;
  readonly sseOpen: boolean;
  readonly lastSignalAgeMs: number | null;
  readonly proxyStatus: "healthy" | "degraded" | "unavailable" | null;
}

// The server sends SSE keepalives every 15s by default; a connected stream
// that has gone quiet past twice that interval is treated as stale.
export const STALE_THRESHOLD_MS = 30_000;

// Priority order encodes the recovery ladder: a server the dashboard cannot
// reach is unavailable; a dropped stream is reconnecting; a connected but
// silent stream is stale; a reachable server reporting an unhealthy proxy is
// degraded; otherwise live. The shell and last known summary survive all of
// these — no state clears the retained data, so no reload is ever needed.
export function computeConnectionStatus(input: ConnectionInput): ConnectionStatus {
  if (input.bootstrapFailed) return "unavailable";
  if (!input.hasSnapshot) return "bootstrapping";
  if (!input.sseOpen) return "reconnecting";
  if (input.lastSignalAgeMs === null || input.lastSignalAgeMs > STALE_THRESHOLD_MS) {
    return "stale";
  }
  if (input.proxyStatus !== null && input.proxyStatus !== "healthy") return "degraded";
  return "live";
}

const STATUS_COPY: Readonly<Record<ConnectionStatus, string>> = Object.freeze({
  bootstrapping: "Connecting to the local server…",
  live: "Live",
  reconnecting: "Connection lost — reconnecting",
  stale: "Stream stalled — falling back to polling",
  degraded: "Connected — proxy degraded",
  unavailable: "Server unreachable — showing last known values",
});

export function statusCopy(status: ConnectionStatus): string {
  return STATUS_COPY[status];
}
