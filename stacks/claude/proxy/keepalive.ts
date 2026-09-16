/**
 * keepalive — hold a named session's upstream prompt cache open while nobody is
 * typing, by re-sending that session's own last request with `max_tokens: 0` on a
 * padded timer.
 *
 * **The name, and the word this module does not use.** This file is deliberately not
 * `warm.ts`, and it exports no identifier built on `warm`. `cache-breakpoint.ts`
 * already owns that word in this package — `warmSessions`, `hasWarmPrefix`,
 * `WARM_LIMIT`, `_resetWarmPrefixes` — where it means *"this session has been observed
 * reading past its own system prefix"*: a statement about evidence already collected.
 * This module means something unrelated — *"keep the upstream cache from expiring"*: an
 * action taken on the future. Two senses of one word in one directory collide for every
 * later reader, so the word stays with whoever had it first. See ADR 0077 §5. The
 * `/__warm` endpoint and the `/warm` command keep their names; they face outward, not
 * into this package.
 *
 * **A ping never enters `handle()`.** This module issues its own `https.request` to the
 * upstream. That one choice is what keeps a ping out of the skim cache, out of
 * `appendSession`, out of `auditRequest`, `recordPrompt` and `writeAuditSidecar`, and —
 * sharpest of all — out of `noteCacheRead`, which would otherwise mark a session warm in
 * the sense above on the strength of a cache read this proxy manufactured, and feed that
 * flag straight into `ensureMessageBreakpoint`'s gate. None of those is reachable from
 * outside `handle()`, so none of them is skipped by name. That is the point: an
 * enumerated skip list is a standing invitation to miss the next side effect somebody
 * adds to `handle()`, while a path that never acquires them cannot miss one. See ADR
 * 0077 §1.
 *
 * **In memory only.** The registry holds a stored request body, stored headers, and a
 * borrowed bearer. None of it is ever written to disk — not to a sidecar, not to a status
 * file, not to a log line. That is a repository rule rather than a preference, and a
 * proxy restart clearing the whole registry is the intended behaviour rather than a gap.
 * What may be published (by ticket 02, through `snapshot()`) is counts, timestamps and
 * reasons.
 *
 * **The credential is not pinned to the entry.** A keep-alive entry exists precisely
 * because its session went quiet, so the bearer captured with it ages with nothing to
 * refresh it. Every ping therefore takes the newest bearer observed for the *same*
 * `account_uuid` at send time, with no cross-account fallback ever, and a 401 or 403 is
 * a named stop of its own rather than a tick of the generic failure counter. See ADR
 * 0076.
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { asList, asNumber, asRecord, asText, type JsonObject, type JsonValue, parseJson } from './json.ts';
import type { HeaderBag, RequestBody } from './wire.ts';

/** The upstream this proxy forwards to, and the endpoint a ping replays against. */
const UPSTREAM_HOST = 'api.anthropic.com';
const MESSAGES_PATH = '/v1/messages';

/**
 * How long an entry is held open when a registration names no duration of its own, in
 * hours. A default and not a ceiling: nothing here bounds an explicit `hours`. ADR 0078
 * ships it knowing the measured resume rate sits below break-even, and ADR 0076 notes the
 * real limit in an all-sessions-idle case is the bearer's own lifetime.
 */
export const MAX_DEADLINE_HOURS = 8;

/**
 * The cache TTL assumed when a stored body carries no `cache_control` TTL at all — the
 * API's own default for an ephemeral breakpoint. Never used in place of a TTL the body
 * states: {@link deriveTtlMs} reads the client's value so a client-side TTL change
 * carries through without a proxy edit, exactly as `cache-breakpoint.ts` clones the
 * client's `cache_control` rather than rebuilding it.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/**
 * How far into an entry's TTL a ping fires, as a fraction of it. An entry's lifetime is
 * measured from the *start* of the request that reads or writes it, so the interval is
 * padded rather than fired at expiry: 83% of an hour is roughly 50 minutes, which leaves
 * a ten-minute margin for a slow request against a one-hour cache.
 */
export const PING_AT_TTL_FRACTION = 0.83;

/** How often the single registry-wide sweeper wakes up to look for due entries. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * How long a registration may sit `pending` before it is stopped as unmatched. A `/warm`
 * registration names a session id this proxy has not necessarily joined to the ids it
 * sees on the wire, so registration is a handshake rather than an assertion: it stays
 * pending until a real request matches it, and expiring loudly is what stops the feature
 * from silently holding nothing open. See ADR 0075.
 */
export const PENDING_TTL_MS = 2 * 60_000;

/** Two failures in a row retires an entry; one is an upstream wobble. */
const MAX_CONSECUTIVE_FAILURES = 2;

/** Above this utilization of Anthropic's own meter, stop rather than spend more. */
export const DEFAULT_UTILIZATION_STOP = 0.9;

/**
 * Request headers a ping must never replay: the stored credential, anything routing, and
 * `accept-encoding`.
 *
 * **`accept-encoding` is dropped rather than handled at send time**, so the upstream
 * answers in identity encoding — what `forwardHeaders` in `proxy.ts` does to the real
 * forwarded request. This package has zero runtime dependencies and so no decompressor:
 * a gzipped reply leaves {@link readUsage} with nothing to parse, and a ping that read
 * the cache reports all four token counts as 0.
 */
const DROPPED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
]);

/** A `tool_choice` of one of these kinds forces a call, which `max_tokens: 0` rejects. */
const FORCED_TOOL_CHOICE = new Set(['any', 'tool']);

/** Where an entry is in its life: registered, matched and pinging, or retired. */
export type KeepaliveState = 'pending' | 'armed' | 'stopped';

/**
 * Why an entry retired. `credential-expired` and `no-credential` are deliberately
 * separate from `ping-failures`: a credential problem is a different event from an
 * upstream wobble, and folding it into a generic counter is the silent failure ADR 0076
 * exists to prevent.
 */
export type StopReason =
  | 'deadline'
  | 'unmatched'
  | 'ping-failures'
  | 'rate-limited'
  | 'credential-expired'
  | 'no-credential'
  | 'usage-limit'
  | 'released';

/** The terminal record an entry carries once it stops. */
export interface KeepaliveOutcome {
  reason: StopReason;
  at: number;
  /** One short clause — a status code, a count. Never a body, prompt or credential. */
  detail?: string;
}

/**
 * The non-auth request headers a ping replays, by header name. Named rather than written
 * inline at each use, so the one contract — header name to single value, credential
 * already dropped — is stated once and every holder of one is holding the same thing.
 */
export type StoredHeaders = Record<string, string>;

/** One registry entry. The body, the headers and the bearer never leave this process. */
interface Entry {
  sessionKey: string;
  /** `account_uuid` from `metadata.user_id`; the only scope a bearer may be borrowed in. */
  account: string | null;
  /** The stored forward body a ping replays. */
  body: RequestBody | null;
  /** The stored non-auth headers a ping replays. */
  headers: StoredHeaders;
  ttlMs: number;
  deadline: number;
  lastActivity: number;
  registeredAt: number;
  state: KeepaliveState;
  pingsSent: number;
  /** Cumulative `cache_read_input_tokens` this entry's own pings have read. */
  cacheReadTokens: number;
  /** The last ping's own counts, or null before one has been sent. */
  lastPing: LastPing | null;
  consecutiveFailures: number;
  outcome: KeepaliveOutcome | null;
}

/**
 * What an entry looks like from outside — counts, timestamps and reasons only. This is
 * the whole publishable surface, and it is what ticket 02 writes into `logs/warm.json`.
 * No body, no headers, no credential, by construction rather than by filtering.
 */
export interface EntrySnapshot {
  sessionKey: string;
  account: string | null;
  state: KeepaliveState;
  ttlMs: number;
  deadline: number;
  lastActivity: number;
  registeredAt: number;
  pingsSent: number;
  cacheReadTokens: number;
  lastPing: LastPing | null;
  outcome: KeepaliveOutcome | null;
}

/**
 * What one ping came back with. The three counts beside `cacheReadTokens` are optional, so
 * a stubbed transport stays a plain object literal.
 */
export interface PingResult {
  statusCode: number;
  cacheReadTokens: number;
  inputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
}

/**
 * The whole reply to the last ping this entry sent. Recorded for **every** reply, not only
 * a successful one — a refused ping never increments `pingsSent`, so its status code would
 * otherwise leave no trace.
 *
 * **Reading it.** A large `inputTokens` beside a zero `cacheReadTokens` is a ping that paid
 * for the prefix without reading the cache: cost with no benefit, and the registration is
 * worth releasing. A large `cacheReadTokens` is a ping doing its job. Both zero on a 2xx
 * means the reply carried no `usage` this could read — a reporting fault rather than a
 * verdict on the cache.
 */
export interface LastPing {
  /** When the ping *began* — the same instant its effect on the cache is measured from. */
  at: number;
  statusCode: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** What {@link pingNow} answers: the ping it sent, or why it sent none. */
export interface ForcedPingResult {
  ok: boolean;
  /** Why the ping was refused; absent on success. */
  reason?: string;
  state?: KeepaliveState;
  lastPing?: LastPing | null;
}

/** The upstream call a ping makes, as a seam a test can stand in for. */
export type PingTransport = (request: { body: string; headers: StoredHeaders }) => Promise<PingResult>;

/**
 * The newest bearer observed for one `account_uuid`, or null when none is held. Ticket 02
 * wires the account-keyed store behind this; there is no cross-account fallback, and a
 * null answer stops the entry rather than reaching for another account's token.
 */
export type BearerSource = (account: string | null) => string | null;

/**
 * Current utilization of Anthropic's own meter, 0–1, or null when it is unknown. Read
 * from `usage-live.json` — Anthropic billed the pings, so that meter already counts them.
 * **Never compute this from the local sidecar corpus**, which by design does not record a
 * ping at all. See ADR 0077 §2.
 */
export type UtilizationSource = () => number | null;

/** The registry: session key to entry. In memory only, cleared by a proxy restart. */
const entries = new Map<string, Entry>();

let bearerSource: BearerSource = () => null;
let utilizationSource: UtilizationSource = () => null;
let pingTransport: PingTransport = httpsPing;
let utilizationStop = DEFAULT_UTILIZATION_STOP;

/** Wire the account-keyed bearer store. Ticket 02's seam. */
export function setBearerSource(source: BearerSource): void {
  bearerSource = source;
}

/** Wire the utilization reader, and optionally move the stop threshold. */
export function setUtilizationSource(source: UtilizationSource, stopAbove = DEFAULT_UTILIZATION_STOP): void {
  utilizationSource = source;
  utilizationStop = stopAbove;
}

/** Swap the upstream call. Test seam; the default is a real `https.request`. */
export function setPingTransport(transport: PingTransport): void {
  pingTransport = transport;
}

/**
 * Test seam: forget every entry and every wired seam, as `_resetWarmPrefixes` and
 * `resetAuth` do for their own modules.
 */
export function _resetKeepalive(): void {
  entries.clear();
  bearerSource = () => null;
  utilizationSource = () => null;
  pingTransport = httpsPing;
  utilizationStop = DEFAULT_UTILIZATION_STOP;
}

/**
 * A reader of Anthropic's utilization from `<logDir>/usage-live.json`, as
 * {@link setUtilizationSource} wants one. Takes the highest utilization any window
 * reports, since the binding constraint is whichever window runs out first, and answers
 * null when the file is absent or unreadable — an unknown meter never stops an entry.
 */
export function usageLiveUtilization(logDir: string): UtilizationSource {
  return () => {
    try {
      const raw = fs.readFileSync(path.join(logDir, 'usage-live.json'), 'utf8');
      return highestUtilization(parseJson(raw));
    } catch {
      return null;
    }
  };
}

/** The largest `utilization`/`percent` reading anywhere in a usage payload, as 0–1. */
function highestUtilization(payload: JsonValue | null, depth = 0): number | null {
  if (depth > 6) return null;
  let best: number | null = null;
  const take = (value: number | null): void => {
    if (value === null) return;
    const normalized = value > 1 ? value / 100 : value;
    if (best === null || normalized > best) best = normalized;
  };
  const record = asRecord(payload ?? undefined);
  if (record !== null) {
    take(asNumber(record.utilization));
    take(asNumber(record.percent));
    for (const key of Object.keys(record)) {
      if (key === 'utilization' || key === 'percent') continue;
      take(highestUtilization(record[key] ?? null, depth + 1));
    }
    return best;
  }
  const list = asList(payload ?? undefined);
  if (list !== null) {
    for (const item of list) take(highestUtilization(item, depth + 1));
  }
  return best;
}

/**
 * The hours a registration asked for, honoured verbatim. Pure, and exported so a test
 * reaches it without starting a timer.
 *
 * Answers null for anything that is not a usable duration — a non-finite value, a NaN, a
 * zero or a negative one — because there is no sensible floor to round those up to, and a
 * registration that asked for nonsense should be refused rather than silently given a
 * default it never requested. Nothing bounds it from above; ADR 0078 records the removed
 * ceiling and what it costs.
 */
export function validateDeadlineHours(hours: number | null | undefined): number | null {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return null;
  return hours;
}

/** `"1h"`, `"5m"`, `"30s"`, `"250ms"` as milliseconds; null when it is none of those. */
function parseTtl(raw: string | null): number | null {
  if (raw === null) return null;
  const matched = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/.exec(raw);
  if (matched === null) return null;
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (matched[2]) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1_000;
    case 'm':
      return amount * 60_000;
    default:
      return amount * 3_600_000;
  }
}

/** The last `cache_control.ttl` anywhere in the body, in document order. */
function lastCacheTtl(value: JsonValue | undefined, depth = 0): string | null {
  if (depth > 6) return null;
  const record = asRecord(value);
  if (record !== null) {
    let found = asText(asRecord(record.cache_control)?.ttl);
    for (const key of Object.keys(record)) {
      if (key === 'cache_control') continue;
      const inner = lastCacheTtl(record[key], depth + 1);
      if (inner !== null) found = inner;
    }
    return found;
  }
  const list = asList(value);
  if (list !== null) {
    let found: string | null = null;
    for (const item of list) {
      const inner = lastCacheTtl(item, depth + 1);
      if (inner !== null) found = inner;
    }
    return found;
  }
  return null;
}

/**
 * The cache TTL this body asked for, in milliseconds — read off the `cache_control` the
 * client already shipped rather than hardcoded, so a client-side TTL change carries
 * through with no proxy edit. Falls back to {@link DEFAULT_CACHE_TTL_MS} when the body
 * carries no TTL at all.
 */
export function deriveTtlMs(body: RequestBody | null | undefined): number {
  return parseTtl(lastCacheTtl(body ?? undefined)) ?? DEFAULT_CACHE_TTL_MS;
}

/**
 * The stored body as a ping sends it: `max_tokens: 0`, and exactly the four fields the
 * API rejects in combination with it removed. **Every other byte survives**, because the
 * cached prefix stops matching the moment one changes.
 *
 * The four, each an `invalid_request_error` alongside `max_tokens: 0`:
 *
 * - `stream: true` — transport rather than prefix, so dropping it costs no cache hit.
 * - `thinking.type: "enabled"`.
 * - `output_config.format` — the key alone; `output_config` itself is dropped only when
 *   removing `format` would leave an empty object behind.
 * - a **forced** `tool_choice`, meaning `{"type":"any"}` or `{"type":"tool"}`.
 *   `{"type":"auto"}` is not forced and is left exactly where it is.
 *
 * Measured across 3,292 archived request bodies: `stream: true` on 2,281,
 * `output_config` on 2,314, a forced `tool_choice` on 1, and `thinking.enabled` on 0 —
 * the last defensive rather than observed, and tested all the same.
 *
 * Answers null when the stored value was not an object at all.
 */
export function buildPingBody(body: RequestBody | null | undefined): RequestBody | null {
  if (body == null || asRecord(body) === null) return null;
  const next: RequestBody = { ...body };

  if (next.stream === true) delete next.stream;

  if (asText(asRecord(next.thinking)?.type) === 'enabled') delete next.thinking;

  const outputConfig = asRecord(next.output_config);
  if (outputConfig !== null && outputConfig.format !== undefined) {
    const rest: JsonObject = { ...outputConfig };
    delete rest.format;
    if (Object.keys(rest).length === 0) delete next.output_config;
    else next.output_config = rest;
  }

  const toolChoiceKind = asText(asRecord(next.tool_choice)?.type);
  if (toolChoiceKind !== null && FORCED_TOOL_CHOICE.has(toolChoiceKind)) delete next.tool_choice;

  next.max_tokens = 0;
  return next;
}

/** The stored headers, with the credential and every hop-by-hop name dropped. */
export function storableHeaders(headers: HeaderBag | undefined | null) {
  const kept: StoredHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (DROPPED_HEADERS.has(name.toLowerCase())) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined) continue;
    kept[name] = first;
  }
  return kept;
}

export interface RegisterOptions {
  sessionKey: string;
  /** Requested hours, validated by {@link validateDeadlineHours} and otherwise unaltered. */
  hours: number;
  now?: number;
}

export interface RegisterResult {
  ok: boolean;
  state?: KeepaliveState;
  deadline?: number;
  /** Why a registration was refused; absent on success. */
  reason?: string;
}

/**
 * Register a session to be held open. The entry starts `pending` and holds no body: a
 * `/warm` registration names a session id this proxy has not joined to the ids it sees on
 * the wire, so it becomes real only when {@link noteRequest} matches a forwarded request
 * against it. See ADR 0075.
 */
export function register({ sessionKey, hours, now = Date.now() }: RegisterOptions): RegisterResult {
  if (!sessionKey) return { ok: false, reason: 'no session key' };
  const validated = validateDeadlineHours(hours);
  if (validated === null) return { ok: false, reason: 'hours must be a finite number above zero' };
  const deadline = now + validated * 3_600_000;
  entries.set(sessionKey, {
    sessionKey,
    account: null,
    body: null,
    headers: {},
    ttlMs: DEFAULT_CACHE_TTL_MS,
    deadline,
    lastActivity: now,
    registeredAt: now,
    state: 'pending',
    pingsSent: 0,
    cacheReadTokens: 0,
    lastPing: null,
    consecutiveFailures: 0,
    outcome: null,
  });
  return { ok: true, state: 'pending', deadline };
}

/**
 * A real request arrived for this session. It matches a pending registration and arms it,
 * and on an already-armed entry it refreshes the stored body and resets `lastActivity` —
 * which is what makes the next sweep skip the ping. `startedAt` is the instant the
 * request *began*, since that is what the upstream cache's own lifetime is measured from.
 *
 * Returns true when an entry took it, false when this session is not registered.
 */
export function noteRequest(args: {
  sessionKey: string | null | undefined;
  account?: string | null;
  body?: RequestBody | null;
  headers?: HeaderBag | null;
  startedAt?: number;
}): boolean {
  const key = args.sessionKey;
  if (!key) return false;
  const entry = entries.get(key);
  if (entry === undefined || entry.state === 'stopped') return false;
  const at = args.startedAt ?? Date.now();
  entry.lastActivity = at;
  entry.consecutiveFailures = 0;
  if (args.account !== undefined && args.account !== null) entry.account = args.account;
  if (args.body != null) {
    entry.body = args.body;
    entry.ttlMs = deriveTtlMs(args.body);
  }
  if (args.headers != null) entry.headers = storableHeaders(args.headers);
  if (entry.state === 'pending' && entry.body !== null) entry.state = 'armed';
  return true;
}

/** Retire an entry deliberately — the `/warm --stop` path. */
export function release(sessionKey: string, now = Date.now()): boolean {
  const entry = entries.get(sessionKey);
  if (entry === undefined || entry.state === 'stopped') return false;
  stop(entry, 'released', now);
  return true;
}

/** Counts, timestamps and reasons for every entry. Never a body, header or credential. */
export function snapshot(): EntrySnapshot[] {
  return [...entries.values()].map((entry) => ({
    sessionKey: entry.sessionKey,
    account: entry.account,
    state: entry.state,
    ttlMs: entry.ttlMs,
    deadline: entry.deadline,
    lastActivity: entry.lastActivity,
    registeredAt: entry.registeredAt,
    pingsSent: entry.pingsSent,
    cacheReadTokens: entry.cacheReadTokens,
    lastPing: entry.lastPing,
    outcome: entry.outcome,
  }));
}

/** Retire an entry with its reason recorded. */
function stop(entry: Entry, reason: StopReason, at: number, detail?: string): void {
  entry.state = 'stopped';
  entry.outcome = detail === undefined ? { reason, at } : { reason, at, detail };
}

/** Whether this entry is due for a ping — past its padded interval, inside its deadline. */
function isDue(entry: Entry, now: number): boolean {
  return now - entry.lastActivity >= entry.ttlMs * PING_AT_TTL_FRACTION && now < entry.deadline;
}

/**
 * One pass over the whole registry. Every stop condition is checked here, in the order a
 * cheaper one should win: the hard deadline, an unmatched registration, the usage meter,
 * then the ping itself and what came back from it. A real request arriving is not checked
 * here at all — {@link noteRequest} already moved `lastActivity`, so the entry simply is
 * not due.
 */
export async function sweepOnce(now = Date.now()): Promise<void> {
  const utilization = utilizationSource();
  for (const entry of entries.values()) {
    if (entry.state === 'stopped') continue;

    if (now >= entry.deadline) {
      stop(entry, 'deadline', now);
      continue;
    }
    if (entry.state === 'pending') {
      if (now - entry.registeredAt >= PENDING_TTL_MS) stop(entry, 'unmatched', now);
      continue;
    }
    if (utilization !== null && utilization >= utilizationStop) {
      stop(entry, 'usage-limit', now, `utilization ${Math.round(utilization * 100)}%`);
      continue;
    }
    if (!isDue(entry, now)) continue;

    const bearer = bearerSource(entry.account);
    if (bearer === null) {
      stop(entry, 'no-credential', now);
      continue;
    }
    await sendPing(entry, bearer, now);
  }
}

/** Send one ping for an entry and fold the answer back into it. */
async function sendPing(entry: Entry, bearer: string, startedAt: number): Promise<void> {
  const pingBody = buildPingBody(entry.body);
  if (pingBody === null) {
    stop(entry, 'ping-failures', startedAt, 'stored body is not a request');
    return;
  }
  const payload = JSON.stringify(pingBody);
  const headers = {
    ...entry.headers,
    authorization: bearer,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
  };

  let result: PingResult;
  try {
    result = await pingTransport({ body: payload, headers });
  } catch {
    // Never interpolate the cause: a request error can carry the credential.
    noteFailure(entry, startedAt, 'transport error');
    return;
  }

  const status = result.statusCode;
  // Before the branching below, so a refusal is recorded as well as a success.
  entry.lastPing = {
    at: startedAt,
    statusCode: status,
    inputTokens: result.inputTokens ?? 0,
    cacheCreationTokens: result.cacheCreationTokens ?? 0,
    cacheReadTokens: result.cacheReadTokens,
    outputTokens: result.outputTokens ?? 0,
  };
  if (status === 401 || status === 403) {
    // Named and reported on its own. A credential expiry is not an upstream wobble,
    // and laundering it into the failure counter is the silent failure ADR 0076 names.
    stop(entry, 'credential-expired', startedAt, `HTTP ${status}`);
    return;
  }
  if (status === 429 || status === 529) {
    stop(entry, 'rate-limited', startedAt, `HTTP ${status}`);
    return;
  }
  if (status < 200 || status >= 300) {
    noteFailure(entry, startedAt, `HTTP ${status}`);
    return;
  }

  entry.pingsSent += 1;
  entry.cacheReadTokens += result.cacheReadTokens;
  entry.consecutiveFailures = 0;
  // Measured from the instant the ping *began*, which is where the upstream cache's own
  // lifetime starts too.
  entry.lastActivity = startedAt;
}

/**
 * Send one ping for a named entry now, outside the padded schedule.
 *
 * **Every guard the sweep applies still applies.** A stopped entry, one that never armed,
 * one past its deadline, one with no bearer for its account: each is refused with a reason
 * rather than pinged. What this skips is {@link isDue} and nothing else.
 *
 * A forced ping moves `lastActivity` exactly as a scheduled one does — that is the ping's
 * own effect on the cached prefix's lifetime — so the next scheduled ping is measured from
 * here.
 */
export async function pingNow(sessionKey: string, now = Date.now()): Promise<ForcedPingResult> {
  const entry = entries.get(sessionKey);
  if (entry === undefined) return { ok: false, reason: 'no such registration' };
  if (entry.state === 'stopped') {
    return { ok: false, reason: 'the registration has stopped', state: entry.state };
  }
  if (entry.state === 'pending') {
    return { ok: false, reason: 'the registration is pending — no request has matched it yet', state: entry.state };
  }
  if (now >= entry.deadline) {
    return { ok: false, reason: 'the registration is past its deadline', state: entry.state };
  }
  const bearer = bearerSource(entry.account);
  if (bearer === null) {
    return { ok: false, reason: 'no credential is held for this account', state: entry.state };
  }
  await sendPing(entry, bearer, now);
  return { ok: true, state: entry.state, lastPing: entry.lastPing };
}

/** Count one failure, and retire the entry on the second in a row. */
function noteFailure(entry: Entry, at: number, detail: string): void {
  entry.consecutiveFailures += 1;
  if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    stop(entry, 'ping-failures', at, detail);
  }
}

/**
 * Start the one sweeper the whole registry shares — not one timer per entry. Unref'd, so
 * it never holds the process open, exactly as `startUsagePolling` does. Returns the
 * function that stops it.
 */
export function startKeepalive({ intervalMs = SWEEP_INTERVAL_MS }: { intervalMs?: number } = {}): () => void {
  const timer = setInterval(() => {
    void sweepOnce();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The default transport: this module's own `https.request` to the upstream, which is what
 * keeps a ping out of `handle()` and therefore out of every side effect reachable from
 * it. Reads only the token counts off the reply; the body itself is dropped.
 */
function httpsPing({ body, headers }: { body: string; headers: StoredHeaders }): Promise<PingResult> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { hostname: UPSTREAM_HOST, port: 443, path: MESSAGES_PATH, method: 'POST', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            ...readUsage(Buffer.concat(chunks).toString('utf8')),
          });
        });
        response.on('error', reject);
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error('ping timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

/** The four token counts off a reply's `usage`, each 0 when it says nothing useful. */
function readUsage(text: string): Omit<PingResult, 'statusCode'> {
  const usage = asRecord(asRecord(parseJson(text) ?? undefined)?.usage);
  return {
    inputTokens: asNumber(usage?.input_tokens) ?? 0,
    cacheCreationTokens: asNumber(usage?.cache_creation_input_tokens) ?? 0,
    cacheReadTokens: asNumber(usage?.cache_read_input_tokens) ?? 0,
    outputTokens: asNumber(usage?.output_tokens) ?? 0,
  };
}
