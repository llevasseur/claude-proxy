import type { LiveStatus } from "../useLiveQuery";

const LABELS: Record<LiveStatus, string> = { live: "Live", connecting: "Connecting…", offline: "Offline" };
const DOTS: Record<LiveStatus, string> = { live: "ok", connecting: "warn", offline: "bad" };

/** Small SSE connection badge — reuses the health-badge layout. */
export function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <div className="health" title="Live updates via server-sent events">
      <span className={`dot ${DOTS[status]}`} />
      {LABELS[status]}
    </div>
  );
}
