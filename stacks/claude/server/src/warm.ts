/**
 * Warm sessions, read through to the proxy's `/__warm` control endpoint.
 *
 * There is no corpus to derive this from. The keepalive registry lives in the proxy's own
 * memory, and its two published readings are that endpoint and the `logs/warm.json` mirror
 * the proxy renames into place beside it. **This module reads the endpoint rather than the
 * mirror**, because the same endpoint is what retires an entry — a file cannot be asked to
 * stop one — and reading the list and issuing the release through one door is what keeps
 * them from disagreeing about a session that was released a moment ago.
 *
 * [ADR 0079](../../../../docs/adrs/0079-warm-json-ships-without-a-dashboard-card.md)
 * deferred this surface and said the reader it needs requires no proxy change. This is that
 * reader; the proxy is untouched.
 *
 * Everything the endpoint answers is status — counts, timestamps and stop reasons, by the
 * construction of `snapshot()` rather than by filtering here. No body, prompt or credential
 * passes through, so this module redacts nothing and must never start needing to.
 */
import { errorMessage } from './errors.js';
import { type JsonObject, jsonObject, numberField, objectArray, objectField, parseJson, stringField } from './json.js';

/** The proxy's control path. Loopback-only at the far end, which the server satisfies. */
const WARM_PATH = '/__warm';

/**
 * The one call this module makes, as a seam a test can stand in for.
 *
 * Narrower than `typeof fetch` on purpose — the global is assignable to it, and a test stub
 * is then a plain function rather than a cast.
 */
export type WarmFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * The proxy did not answer, or answered something this cannot read.
 *
 * Distinct from a programming fault so the route can say 502: "the proxy is down" must not
 * render as "no session is warm".
 */
export class WarmProxyError extends Error {
  constructor(message: string) {
    super(`warm proxy ${message}`);
    this.name = 'WarmProxyError';
  }
}

/**
 * What the last ping came back with. The cumulative `cacheReadTokens` beside it cannot
 * separate a ping that read no cache from one the upstream refused; these can.
 */
export interface WarmLastPing {
  at: string;
  statusCode: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  usageUnits: number;
}

/** One registered session, as the proxy's status document describes it. */
export interface WarmEntry {
  sessionKey: string;
  account: string | null;
  /** `pending` until a real request matches the registration, then `armed`; `stopped` once retired. */
  state: string;
  pingsSent: number;
  cacheReadTokens: number;
  usageUnits: number;
  /** The cached prefix's own TTL, which is what sets the ping cadence. */
  ttlMs: number;
  registeredAt: string;
  lastActivity: string;
  deadline: string;
  outcome: string | null;
  /** One short clause — a status code or a count. Never a body. */
  outcomeDetail: string | null;
  resumedAt: string | null;
  resumedAfterPings: number | null;
  /** Null until this entry has sent a ping, and on a proxy too old to report one. */
  lastPing: WarmLastPing | null;
  /** The proxy's own one-word reading of `lastPing`; null when it reported none. */
  lastPingVerdict: string | null;
}

/** The document's own totals, carried through rather than recomputed from the rows. */
export interface WarmTotals {
  entries: number;
  pending: number;
  armed: number;
  stopped: number;
  resumed: number;
  pingsSent: number;
  cacheReadTokens: number;
  usageUnits: number;
}

export interface WarmStatusResponse {
  /** When the proxy built the document, not when this server read it. */
  updatedAt: string | null;
  entries: WarmEntry[];
  totals: WarmTotals;
  meta: { proxy: string };
}

export interface WarmReleaseResponse {
  sessionId: string;
  /** False when the proxy held no such registration — an answer, not a failure. */
  released: boolean;
  meta: { proxy: string };
}

async function callWarm(base: string, init: Parameters<WarmFetch>[1], fetchImpl: WarmFetch): Promise<JsonObject> {
  const response = await fetchImpl(`${base}${WARM_PATH}`, init).catch((cause: unknown) => {
    throw new WarmProxyError(`unreachable at ${base}: ${errorMessage(cause)}`);
  });
  const body = jsonObject(parseJson(await response.text()));
  if (body === undefined) {
    throw new WarmProxyError(`answered ${response.status} with a body that is not a JSON object`);
  }
  if (!response.ok) {
    // The endpoint's own refusals are already prose — the loopback rule, a missing
    // sessionId — so they are relayed rather than restated.
    throw new WarmProxyError(`answered ${response.status}: ${stringField(body, 'error') ?? 'no reason given'}`);
  }
  return body;
}

/**
 * Narrow one row. Every field is defaulted rather than required — the proxy is a separate
 * process on its own release cycle, so a row that lost a field costs that cell, not the page.
 */
function toEntry(raw: JsonObject): WarmEntry {
  return {
    sessionKey: stringField(raw, 'sessionKey') ?? '',
    account: stringField(raw, 'account') ?? null,
    state: stringField(raw, 'state') ?? 'unknown',
    pingsSent: numberField(raw, 'pingsSent') ?? 0,
    cacheReadTokens: numberField(raw, 'cacheReadTokens') ?? 0,
    usageUnits: numberField(raw, 'usageUnits') ?? 0,
    ttlMs: numberField(raw, 'ttlMs') ?? 0,
    registeredAt: stringField(raw, 'registeredAt') ?? '',
    lastActivity: stringField(raw, 'lastActivity') ?? '',
    deadline: stringField(raw, 'deadline') ?? '',
    outcome: stringField(raw, 'outcome') ?? null,
    outcomeDetail: stringField(raw, 'outcomeDetail') ?? null,
    resumedAt: stringField(raw, 'resumedAt') ?? null,
    resumedAfterPings: numberField(raw, 'resumedAfterPings') ?? null,
    lastPing: toLastPing(objectField(raw, 'lastPing')),
    lastPingVerdict: stringField(raw, 'lastPingVerdict') ?? null,
  };
}

/** Narrow the last ping's counts, defaulted field by field like the row around it. */
function toLastPing(raw: JsonObject | undefined): WarmLastPing | null {
  if (raw === undefined) return null;
  return {
    at: stringField(raw, 'at') ?? '',
    statusCode: numberField(raw, 'statusCode') ?? 0,
    inputTokens: numberField(raw, 'inputTokens') ?? 0,
    cacheCreationTokens: numberField(raw, 'cacheCreationTokens') ?? 0,
    cacheReadTokens: numberField(raw, 'cacheReadTokens') ?? 0,
    outputTokens: numberField(raw, 'outputTokens') ?? 0,
    usageUnits: numberField(raw, 'usageUnits') ?? 0,
  };
}

/** The totals the document carries, with the row count as the one honest fallback. */
function toTotals(raw: JsonObject | undefined, entries: readonly WarmEntry[]): WarmTotals {
  const count = (key: string, fallback: number): number => numberField(raw, key) ?? fallback;
  return {
    entries: count('entries', entries.length),
    pending: count('pending', entries.filter((entry) => entry.state === 'pending').length),
    armed: count('armed', entries.filter((entry) => entry.state === 'armed').length),
    stopped: count('stopped', entries.filter((entry) => entry.state === 'stopped').length),
    resumed: count('resumed', entries.filter((entry) => entry.resumedAt !== null).length),
    pingsSent: count('pingsSent', 0),
    cacheReadTokens: count('cacheReadTokens', 0),
    usageUnits: count('usageUnits', 0),
  };
}

/** Every registered session the proxy is holding, as it reports them. */
export async function buildWarmStatus(base: string, fetchImpl: WarmFetch = fetch): Promise<WarmStatusResponse> {
  const document = await callWarm(base, { method: 'GET' }, fetchImpl);
  const entries = objectArray(document.entries).map(toEntry);
  return {
    updatedAt: stringField(document, 'updatedAt') ?? null,
    entries,
    totals: toTotals(objectField(document, 'totals'), entries),
    meta: { proxy: base },
  };
}

/**
 * Retire one registration. The warm session never wakes, so stopping it costs no tokens in
 * it. `released: false` means the proxy held nothing under that id — a second click on a
 * stale row.
 */
export async function releaseWarmSession(
  base: string,
  sessionId: string,
  fetchImpl: WarmFetch = fetch,
): Promise<WarmReleaseResponse> {
  const document = await callWarm(
    base,
    { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) },
    fetchImpl,
  );
  return {
    sessionId: stringField(document, 'sessionId') ?? sessionId,
    released: document.released === true,
    meta: { proxy: base },
  };
}
