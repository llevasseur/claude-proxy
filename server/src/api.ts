import {
  computeDigest,
  digestsByDay,
  heuristicAdvice,
  type Advice,
  type TopTool,
  type UsageDigest,
} from "@claude-proxy/core";
import { readSidecars, shiftDay, today } from "./logs.js";

export interface SummaryResponse {
  digest: UsageDigest;
  advice: Advice[];
  meta: { date: string; files: number; parseErrors: number };
}

/** One day's digest + advice, with the trend computed against the prior day. */
export async function buildSummary(logDir: string, date?: string, now: Date = new Date()): Promise<SummaryResponse> {
  const day = date ?? today(now);
  const prevDay = shiftDay(day, -1);
  const [cur, prev] = await Promise.all([
    readSidecars(logDir, { date: day }, now),
    readSidecars(logDir, { date: prevDay }, now),
  ]);
  const priorDigest = computeDigest(prev.sidecars, { date: prevDay });
  const digest = computeDigest(cur.sidecars, { date: day, priorDigest });
  const advice = await heuristicAdvice.advise(digest);
  return { digest, advice, meta: { date: day, files: cur.files, parseErrors: cur.parseErrors } };
}

export interface TrendsResponse {
  digests: UsageDigest[];
  meta: { days: number; files: number; parseErrors: number };
}

/** Per-day digests for the last `days` days (chained day-over-day trend). */
export async function buildTrends(logDir: string, days: number, now: Date = new Date()): Promise<TrendsResponse> {
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { sinceDays: days }, now);
  return { digests: digestsByDay(sidecars), meta: { days, files, parseErrors } };
}

export interface ToolsResponse {
  date: string;
  topTools: TopTool[];
  meta: { files: number; parseErrors: number };
}

/** The full ranked tool-bloat table for a day. */
export async function buildTools(logDir: string, date?: string, now: Date = new Date()): Promise<ToolsResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { date: day }, now);
  const digest = computeDigest(sidecars, { date: day, topN: 200 });
  return { date: day, topTools: digest.topTools, meta: { files, parseErrors } };
}
