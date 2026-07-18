import {
  computeDigest,
  computeSkimDigest,
  digestsByDay,
  heuristicAdvice,
  skimDigestsByDay,
  withheldReport,
  type Advice,
  type SkimDigest,
  type TopTool,
  type UsageDigest,
  type WithheldReport,
} from "@claude-proxy/core";
import { readSidecars, shiftDay, today } from "./logs.js";
import { readDeviceSettings, resolveSettingsPath } from "./settings.js";

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

export interface SkimResponse {
  date: string;
  skim: SkimDigest;
  meta: { files: number; parseErrors: number };
}

/** One day's app-layer skim aggregate: hit-rate, tokens/dollars saved, top shapes. */
export async function buildSkim(logDir: string, date?: string, now: Date = new Date()): Promise<SkimResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { date: day }, now);
  const skim = computeSkimDigest(sidecars, { date: day, topN: 50 });
  return { date: day, skim, meta: { files, parseErrors } };
}

export interface SkimTrendResponse {
  digests: SkimDigest[];
  meta: { days: number; files: number; parseErrors: number };
}

/** Per-day skim aggregates for the last `days` days — hit-rate & savings over time. */
export async function buildSkimTrend(logDir: string, days: number, now: Date = new Date()): Promise<SkimTrendResponse> {
  const { sidecars, files, parseErrors } = await readSidecars(logDir, { sinceDays: days }, now);
  return { digests: skimDigestsByDay(sidecars), meta: { days, files, parseErrors } };
}

export interface WithheldResponse {
  /** The device settings file the deny-list was read from (device-specific). */
  settingsPath: string;
  settingsReadable: boolean;
  report: WithheldReport;
  meta: { days: number; files: number; parseErrors: number };
}

/**
 * The device's withheld-tools policy: which tool schemas `~/.claude/settings.json`
 * keeps out of every request, cross-referenced with the last `days` of traffic
 * so we can confirm each is actually absent. This is a policy/verification view,
 * hence a window rather than a single day.
 */
export async function buildWithheld(
  logDir: string,
  days: number,
  settingsPath: string = resolveSettingsPath(),
  now: Date = new Date(),
): Promise<WithheldResponse> {
  const [{ sidecars, files, parseErrors }, settings] = await Promise.all([
    readSidecars(logDir, { sinceDays: days }, now),
    readDeviceSettings(settingsPath),
  ]);
  const report = withheldReport(sidecars, settings.denyRules);
  return {
    settingsPath: settings.settingsPath,
    settingsReadable: settings.readable,
    report,
    meta: { days, files, parseErrors },
  };
}
