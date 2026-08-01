import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseLiveUsage,
  USAGE_WINDOW_MS,
  type LiveUsage,
  type UsageWindowKind,
} from "@claude-proxy/core";

/**
 * Anthropic's own usage figures, as the proxy last polled them.
 *
 * The proxy writes `usage-live.json` because that is where the OAuth token the
 * endpoint needs already lives; this side only reads the numbers.
 */

/** Five missed polls. Past that the percentages are treated as unknown. */
const FRESH_MS = 5 * 60 * 1000;

export interface LiveUsageSnapshot {
  /** Percentages, only while fresh. */
  live: LiveUsage;
  /** Reset instants, rolled forward to the current window. Outlive the percentages. */
  anchors: Partial<Record<UsageWindowKind, string>>;
  fetchedAt: string | null;
}

const EMPTY: LiveUsageSnapshot = { live: {}, anchors: {}, fetchedAt: null };

/**
 * A reset instant stays useful long after the reading it came with: allowances
 * reset on a fixed cadence, so an old instant rolled forward by whole windows
 * still marks where the current one opened.
 */
function rollForward(resetsAt: string, kind: UsageWindowKind, nowMs: number): string | null {
  const span = USAGE_WINDOW_MS[kind];
  let at = new Date(resetsAt).getTime();
  if (Number.isNaN(at)) return null;
  if (at <= nowMs) at += Math.ceil((nowMs - at) / span) * span;
  return new Date(at).toISOString();
}

export async function loadLiveUsage(logDir: string, now: Date = new Date()): Promise<LiveUsageSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path.join(logDir, "usage-live.json"), "utf8");
  } catch {
    return EMPTY; // never polled, or the proxy has no token yet
  }

  let doc: { fetchedAt?: unknown; payload?: unknown };
  try {
    doc = JSON.parse(raw);
  } catch {
    return EMPTY;
  }

  const nowMs = now.getTime();
  const fetchedAt = typeof doc.fetchedAt === "string" ? doc.fetchedAt : null;
  const fetchedMs = fetchedAt ? new Date(fetchedAt).getTime() : Number.NaN;
  const parsed = parseLiveUsage(doc.payload, now);

  const anchors: Partial<Record<UsageWindowKind, string>> = {};
  for (const [kind, win] of Object.entries(parsed) as [UsageWindowKind, LiveUsage[UsageWindowKind]][]) {
    if (!win?.resetsAt) continue;
    const rolled = rollForward(win.resetsAt, kind, nowMs);
    if (rolled) anchors[kind] = rolled;
  }

  const fresh = Number.isFinite(fetchedMs) && nowMs - fetchedMs < FRESH_MS;
  return { live: fresh ? parsed : {}, anchors, fetchedAt };
}
