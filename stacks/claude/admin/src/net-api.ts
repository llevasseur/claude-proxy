/**
 * The net stack's HTTP API, read from the dashboard.
 *
 * A separate module from `./api` because it talks to a different server: the claude
 * server behind `API_BASE`, and net-server behind `NET_API_BASE`, are two processes on
 * two ports with two route manifests. `./notes-api` is the same shape for the same
 * reason — a boundary `./api`'s generated route manifest does not cover.
 *
 * The types below mirror what `stacks/net/packages/server/src/api.ts` returns, field for
 * field. They are declared here rather than imported because net-server is not a
 * dependency of the dashboard and exports no client package.
 */

import { errorMessage, type JsonValue, readJsonBody } from './json';

// SAFETY: Vite types every key of `import.meta.env` it does not know about through an
// `any` index signature, so this narrows rather than widens. Vite substitutes the literal
// text of `VITE_NET_SERVER_URL` at build time, leaving exactly two outcomes — the string
// that was in `.env`, or the key absent.
const configuredNetBase = import.meta.env.VITE_NET_SERVER_URL as string | undefined;

export const NET_API_BASE = configuredNetBase ?? 'http://localhost:8531';

/** The three settings `/api/config` reads and writes. `null` is unset, not zero. */
export interface NetConfig {
  limitBytes: number | null;
  resetDay: number | null;
  agentPatterns: string[];
}

/** How much corpus there is, so sparse data reads as sparseness rather than as zero. */
export interface NetCoverage {
  sampleCount: number;
  /** UTC epoch milliseconds, or null on an empty corpus. */
  firstSampleAt: number | null;
}

/** The current budget period, inclusive at both ends, as local `YYYY-MM-DD` days. */
export interface NetPeriod {
  start: string;
  end: string;
}

/** One process name's measured wire bytes. Approximate by construction — see the page. */
export interface NetAgentShare {
  name: string;
  bytes: number;
}

/** `GET /api/summary`. */
export interface NetSummary {
  /** UTC epoch milliseconds, or null on an empty corpus. */
  lastSampleAt: number | null;
  bootEpoch: number | null;
  coverage: NetCoverage;
  /** Null on an empty corpus; otherwise always present, since an unset resetDay means the calendar month. */
  period: NetPeriod | null;
  /** Corpus-wide, not period-scoped. */
  totals: { bytesIn: number; bytesOut: number };
  attributedBytes: number;
  /** Measured inside a gap: counted in the totals, attributed to no day. */
  unattributedBytes: number;
  agentShare: NetAgentShare[];
  config: NetConfig;
}

/** One local calendar day. A day with no attributed bytes is `known: false` — a hole, not a zero. */
export interface NetDay {
  date: string;
  bytesIn: number;
  bytesOut: number;
  /** Intersected by a gap or discontinuity span. */
  partial: boolean;
  known: boolean;
}

export type NetGapKind = 'boot' | 'decrease' | 'gap';

/** A span the corpus cannot account for, in UTC epoch milliseconds. */
export interface NetGap {
  start: number;
  end: number;
  kind: NetGapKind;
}

/** `GET /api/days?window=N`, newest day first. */
export interface NetDaysResponse {
  days: NetDay[];
  gaps: NetGap[];
}

/** The subset of the config this page writes. Omit a field to leave it untouched; `null` clears it. */
export interface NetConfigInput {
  limitBytes?: number | null;
  resetDay?: number | null;
}

/**
 * net-server answered, and said no. Carries the status so a 400 from `PUT /api/config`
 * can be surfaced beside the field that caused it.
 */
export class NetApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NetApiError';
  }
}

/**
 * net-server did not answer at all — not running, wrong port, or refusing the connection.
 * Distinct from `NetApiError` because the page renders it as its own state: the collector
 * is resident in that process (decision internet-spend 005), so an unreachable server
 * means no data exists rather than that the figures are zero.
 */
export class NetServerUnreachableError extends Error {
  constructor(readonly url: string) {
    super(`net-server unreachable at ${url}`);
    this.name = 'NetServerUnreachableError';
  }
}

async function send(path: string, init?: RequestInit): Promise<JsonValue | undefined> {
  let response: Response;
  try {
    response = await fetch(`${NET_API_BASE}${path}`, init);
  } catch {
    // `fetch` rejects only on a transport failure; every HTTP status resolves.
    throw new NetServerUnreachableError(NET_API_BASE);
  }
  const body = await readJsonBody(response);
  if (!response.ok) throw new NetApiError(response.status, errorMessage(body) ?? `HTTP ${response.status}`);
  return body;
}

/**
 * `T` comes from the three call sites below, each naming the return type of the one route
 * it fetches. The assertion is that declaration, not a claim made about this response —
 * the same arrangement `./notes-api` uses for the same reason.
 */
async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  // SAFETY: `send` has already established that net-server answered with a 2xx and a
  // parseable JSON body. `T` is supplied by the three exported wrappers below, each
  // naming the interface declared above for the one route it fetches — those interfaces
  // are transcribed from `stacks/net/packages/server/src/api.ts`, so the assertion
  // restates that shared declaration rather than making a claim about this response.
  return (await send(path, init)) as T;
}

export const getNetSummary = (): Promise<NetSummary> => readJson<NetSummary>('/api/summary');

/** `window` is clamped server-side to 1–366 days. */
export const getNetDays = (window: number): Promise<NetDaysResponse> =>
  readJson<NetDaysResponse>(`/api/days?window=${window}`);

export const putNetConfig = (input: NetConfigInput): Promise<NetConfig> =>
  readJson<NetConfig>('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
