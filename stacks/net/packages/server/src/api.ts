// The HTTP API: four routes, dispatched on pathname. Handlers take an injected
// database and clock so the route tests bind no port; `server.ts` adapts node's
// request/response objects onto them.

import type { DatabaseSync } from 'node:sqlite';
import { bucketDays, classifyAgents, filterInterfaces, periodBounds, stripPidSuffix } from './model.ts';
import {
  classifyCorpus,
  clearNetConfigValue,
  groupIntoSeries,
  loadSamples,
  type NetConfig,
  readNetConfig,
  writeNetConfigValue,
} from './store.ts';

export interface ApiContext {
  readonly db: DatabaseSync;
  /** UTC epoch milliseconds — injectable so tests freeze time. */
  readonly clock?: () => number;
  readonly timeZone: string;
}

export interface ApiReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const OPEN_CORS: Record<string, string> = { 'access-control-allow-origin': '*' };

/**
 * Write-CORS, mirroring the claude server's chat shape: GETs answer open, PUT
 * echoes only an origin on the allow list (`NET_ALLOWED_ORIGINS`). A request
 * that declares no origin is a non-browser client and is allowed.
 */
function writeCors(origin: string | undefined, allowedOrigins: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'PUT, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
  if (origin && allowedOrigins.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function json(status: number, body: unknown, headers: Record<string, string> = OPEN_CORS): ApiReply {
  return { status, body, headers };
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function civilDateOf(epochMs: number, timeZone: string): CivilDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`time zone formatter produced no ${type}`);
    return Number(part.value);
  };
  return { year: read('year'), month: read('month'), day: read('day') };
}

function civilDateString(date: CivilDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

function civilDayShifted(date: CivilDate, offsetDays: number): CivilDate {
  // Pure civil-date arithmetic over UTC components — a timezone round-trip
  // here would shift the calendar day itself.
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day) + offsetDays * 86_400_000);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/**
 * The approximate agent share (decision internet-spend 004): measured wire
 * bytes grouped by process name under case-insensitive substring patterns,
 * using the one delta rule. Approximate by construction — name-based
 * attribution over hourly samples.
 */
function agentShare(db: DatabaseSync, config: NetConfig): Array<{ name: string; bytes: number }> {
  const samples = loadSamples(db);
  const wire = filterInterfaces(samples.map((sample) => ({ ...sample, interface: sample.interface })));
  const byName = new Map<string, { bytesIn: number; bytesOut: number }>();
  for (const rows of groupIntoSeries(wire).values()) {
    const first = rows[0];
    if (!first || !classifyAgents(first.name, config.agentPatterns)) continue;
    const name = stripPidSuffix(first.name);
    const bucket = byName.get(name) ?? { bytesIn: 0, bytesOut: 0 };
    let baseline = first;
    for (let index = 1; index < rows.length; index++) {
      const current = rows[index];
      if (!current) break;
      if (current.boot_epoch === baseline.boot_epoch) {
        const newSum = current.bytes_in + current.bytes_out;
        const oldSum = baseline.bytes_in + baseline.bytes_out;
        if (newSum >= oldSum) {
          bucket.bytesIn += current.bytes_in - baseline.bytes_in;
          bucket.bytesOut += current.bytes_out - baseline.bytes_out;
        }
      }
      baseline = current;
    }
    byName.set(name, bucket);
  }
  return [...byName.entries()]
    .map(([name, bucket]) => ({ name, bytes: bucket.bytesIn + bucket.bytesOut }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/** `GET /api/summary` — everything computed at read time over the raw rows. */
export function summary(ctx: ApiContext): ApiReply {
  const db = ctx.db;
  const config = readNetConfig(db);
  const samples = loadSamples(db);
  if (samples.length === 0) {
    return json(200, {
      lastSampleAt: null,
      bootEpoch: null,
      coverage: { sampleCount: 0, firstSampleAt: null },
      period: null,
      totals: { bytesIn: 0, bytesOut: 0 },
      attributedBytes: 0,
      unattributedBytes: 0,
      agentShare: [],
      config,
    });
  }

  const { intervals } = classifyCorpus(db);
  const bucketing = bucketDays(intervals, { timeZone: ctx.timeZone });
  let totalsIn = 0;
  let totalsOut = 0;
  for (const interval of intervals) {
    if (interval.kind !== 'measured') continue;
    totalsIn += interval.bytesIn;
    totalsOut += interval.bytesOut;
  }
  const unattributed = bucketing.unattributedBytesIn + bucketing.unattributedBytesOut;

  const last = samples[samples.length - 1];
  const first = samples[0];

  const nowLocal = civilDateOf(ctx.clock?.() ?? Date.now(), ctx.timeZone);
  const bounds = periodBounds(nowLocal, config.resetDay);

  return json(200, {
    lastSampleAt: last?.timestamp ?? null,
    bootEpoch: last?.boot_epoch ?? null,
    coverage: { sampleCount: samples.length, firstSampleAt: first?.timestamp ?? null },
    period: {
      start: civilDateString(bounds.start),
      end: civilDateString(civilDayShifted(bounds.endExclusive, -1)),
    },
    totals: { bytesIn: totalsIn, bytesOut: totalsOut },
    attributedBytes: totalsIn + totalsOut - unattributed,
    unattributedBytes: unattributed,
    agentShare: agentShare(db, config),
    config,
  });
}

/** `GET /api/days?window=N` — one entry per local calendar day in the window. */
export function days(ctx: ApiContext, search: URLSearchParams): ApiReply {
  const rawWindow = Number(search.get('window') ?? '30');
  const window = Number.isFinite(rawWindow) ? Math.floor(rawWindow) : 30;
  const clamped = Math.min(Math.max(window, 1), 366);

  const { intervals } = classifyCorpus(ctx.db);
  const bucketing = bucketDays(intervals, { timeZone: ctx.timeZone });
  const byDate = new Map(bucketing.days.map((day) => [day.date, day]));

  const today = civilDateOf(ctx.clock?.() ?? Date.now(), ctx.timeZone);
  const out: Array<{
    date: string;
    bytesIn: number;
    bytesOut: number;
    partial: boolean;
    known: boolean;
  }> = [];
  for (let offset = 0; offset < clamped; offset++) {
    const date = civilDateString(civilDayShifted(today, -offset));
    const bucket = byDate.get(date);
    out.push({
      date,
      bytesIn: bucket?.bytesIn ?? 0,
      bytesOut: bucket?.bytesOut ?? 0,
      partial: bucket?.partial ?? false,
      known: bucket ? bucket.status === 'attributed' : false,
    });
  }

  const gaps = intervals
    .filter(
      (interval) =>
        interval.classification === 'boot' ||
        interval.classification === 'decrease' ||
        interval.classification === 'gap',
    )
    .map((interval) => ({ start: interval.start, end: interval.end, kind: interval.classification }));

  return json(200, { days: out, gaps });
}

/**
 * `PUT /api/config` — any subset of the three fields; invalid input is a 400
 * with nothing persisted.
 */
export function putConfig(
  ctx: ApiContext,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: readonly string[],
): ApiReply {
  const headers = writeCors(origin, allowedOrigins);
  if (origin && !allowedOrigins.includes(origin)) {
    return json(403, { error: `origin not allowed: ${origin}` }, headers);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(400, { error: 'config must be a JSON object' }, headers);
  }
  const input = body as Record<string, unknown>;

  if (input.limitBytes !== undefined) {
    const value = input.limitBytes;
    const valid = value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
    if (!valid) return json(400, { error: 'limitBytes must be a positive integer or null' }, headers);
  }
  if (input.resetDay !== undefined) {
    const value = input.resetDay;
    const valid =
      value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 31);
    if (!valid) return json(400, { error: 'resetDay must be an integer between 1 and 31 or null' }, headers);
  }
  if (input.agentPatterns !== undefined) {
    const value = input.agentPatterns;
    const valid = Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
    if (!valid) return json(400, { error: 'agentPatterns must be an array of non-empty strings' }, headers);
  }

  // Nothing above wrote anything: validation completes before the first insert.
  if (input.limitBytes !== undefined) {
    if (input.limitBytes === null) clearNetConfigValue(ctx.db, 'limitBytes');
    else writeNetConfigValue(ctx.db, 'limitBytes', String(input.limitBytes));
  }
  if (input.resetDay !== undefined) {
    if (input.resetDay === null) clearNetConfigValue(ctx.db, 'resetDay');
    else writeNetConfigValue(ctx.db, 'resetDay', String(input.resetDay));
  }
  if (input.agentPatterns !== undefined) {
    writeNetConfigValue(ctx.db, 'agentPatterns', JSON.stringify(input.agentPatterns));
  }

  return json(200, readNetConfig(ctx.db), headers);
}

const CORS_METHODS = new Set(['GET', 'HEAD']);

/**
 * Dispatch one request. Returns null when the pathname is not an API route so
 * the caller can answer 404 itself.
 */
export function handleApiRequest(
  ctx: ApiContext,
  method: string,
  url: URL,
  options: { origin?: string | undefined; body?: unknown; allowedOrigins: readonly string[] },
): ApiReply | null {
  switch (url.pathname) {
    case '/api/summary':
    case '/api/days':
      if (!CORS_METHODS.has(method)) return json(405, { error: `method not allowed: ${method}` }, OPEN_CORS);
      return url.pathname === '/api/summary' ? summary(ctx) : days(ctx, url.searchParams);
    case '/api/config':
      if (method === 'GET') return json(200, readNetConfig(ctx.db), OPEN_CORS);
      if (method === 'PUT') return putConfig(ctx, options.body, options.origin, options.allowedOrigins);
      if (method === 'OPTIONS') return json(204, null, writeCors(options.origin, options.allowedOrigins));
      return json(405, { error: `method not allowed: ${method}` }, writeCors(options.origin, options.allowedOrigins));
    default:
      return null;
  }
}
