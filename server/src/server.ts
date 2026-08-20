import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  API_ROUTES,
  type ApiRoute,
  type ApiRoutePath,
  apiRoute,
  type IdeaFilter,
  type IdeaStatus,
  isApiWriteRoute,
  isIdeaArea,
  isIdeaRepo,
  isIdeaStatus,
  isSuggestionRecurrence,
  isSuggestionStatus,
  isThreadId,
  parseBucketRange,
  parseIdeaClaims,
  parseIdeaComments,
  parseIdeaFilings,
  parseIdeaMarks,
  parseNoteCreate,
  parseNoteId,
  parseNoteUpdate,
  parseSuggestionJudgements,
  parseSuggestionStatusUpdates,
  type SuggestionRecurrence,
  type SuggestionStatus,
} from '@claude-proxy/core';
import {
  applyIdeaArea,
  applyIdeaClaim,
  applyIdeaComment,
  applyIdeaStatus,
  applySuggestionJudge,
  applySuggestionStatus,
  buildCliFunction,
  buildCliInternals,
  buildCommand,
  buildCommandRun,
  buildCommands,
  buildConcept,
  buildConceptSearch,
  buildConcepts,
  buildContext,
  buildContextDay,
  buildContextDayScoped,
  buildContextDetail,
  buildContextMessage,
  buildContextThread,
  buildContextThreadScoped,
  buildContextTool,
  buildFilters,
  buildHooksPlugins,
  buildIdeas,
  buildJob,
  buildJobDelete,
  buildJobFile,
  buildJobs,
  buildMainHistoryHide,
  buildMainHistorySlide,
  buildMainHistorySyncLocal,
  buildMemory,
  buildProjectMemories,
  buildProjects,
  buildPromptDetail,
  buildPromptMix,
  buildPromptSection,
  buildPullRequestBody,
  buildPullRequests,
  buildSession,
  buildSessionBreakdown,
  buildSessionErrors,
  buildSessionGraphNodes,
  buildSessionNodeTexts,
  buildSessionSuggestionBucket,
  buildSessionSuggestions,
  buildSessions,
  buildSessionsGraph,
  buildSessionsLiveness,
  buildSkim,
  buildSkimTrend,
  buildSuggestionStatus,
  buildSummary,
  buildSummaryScoped,
  buildSystemPrompt,
  buildSystemPromptUpdate,
  buildToolSchema,
  buildTools,
  buildTrends,
  buildUsage,
  buildUsageScoped,
  buildWithheld,
  contextPageQuery,
  type RebuildScope,
  rebuildScope,
  type SuggestionJudgeRequest,
} from './api.js';
import { resolveArchiveDir } from './archive.js';
import {
  continueChat,
  endChat,
  listRunningChats,
  resolveChatConfig,
  resolveThreadId,
  startChat,
  stopChat,
  UUID_RE,
} from './chat.js';
import { snapshotChatStream, subscribeChatStream } from './chat-stream.js';
import { type ReconcileResult, reconcileCommandRuns, resolveCommandsDir } from './command-runs.js';
import { RemoteConceptStoreError, remoteConceptStore } from './concepts-remote.js';
import { resolveDbPath } from './db/open.js';
import { recordRouteObservation } from './db/route-observation-store.js';
import {
  dbReadsEnabled,
  readSource,
  shadowSource,
  startSubstrate,
  stopSubstrate,
  substrateSource,
} from './db/runtime.js';
import { ALL_DAYS, resolveAllDays, type SidecarSource } from './db/source.js';
import { errorMessage } from './errors.js';
import { IdeasStoreUnconfiguredError, RemoteIdeasStoreError } from './ideas-remote.js';
import { resolveJobsDir } from './jobs.js';
import { type JsonObject, jsonBoolean, jsonObject, jsonString, parseJson } from './json.js';
import { countSidecarFiles, resolveLogDir } from './logs.js';
import { ERR } from './main-history.js';
import {
  archiveRemoteNote,
  createRemoteNote,
  getRemoteNote,
  listRemoteNotes,
  type NoteListQuery,
  NotesStoreUnconfiguredError,
  RemoteNotesResponseError,
  RemoteNotesStoreError,
  requireRemoteNotesStore,
  restoreRemoteNote,
  searchRemoteNotes,
  updateRemoteNote,
} from './notes-remote.js';
import { shadowCheck, shadowEnabled } from './parity.js';
import { resolveProjectsDir } from './projects.js';
import { resolveSessionFile, resolveSessionsDir } from './sessions.js';
import { resolveSettingsPath } from './settings.js';
import { resolveSystemPromptPath } from './system-prompt.js';
import { resolveUsageLimits } from './usage-config.js';

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '127.0.0.1'; // localhost-only by default
const LOG_DIR = resolveLogDir();
const ARCHIVE_DIR = resolveArchiveDir();
const PROJECTS_DIR = resolveProjectsDir();
const JOBS_DIR = resolveJobsDir();
const USAGE_LIMITS = resolveUsageLimits();
const COMMANDS_DIR = resolveCommandsDir();
const SETTINGS_PATH = resolveSettingsPath();
const SYSTEM_PROMPT_PATH = resolveSystemPromptPath();
const configuredNotesPollMs = Number(process.env.NOTES_POLL_MS ?? 5_000);
const NOTES_POLL_MS =
  Number.isFinite(configuredNotesPollMs) && configuredNotesPollMs > 0 ? configuredNotesPollMs : 5_000;

/**
 * Bring the command-run store up to date — in the background, never as a step of a read.
 *
 * The pass is a full file scan: every session graph in `logs/`, each one's root prompt,
 * and the request index — tens of seconds, against a substrate read of tens of
 * milliseconds. So it no longer sits in front of an `/api/commands*` response: the read
 * beside it answers from the rows already on record, and {@link onCommandStoreChange}
 * pushes newly-reconciled rows to open streams when the pass lands.
 *
 * The pass is the only writer, so concurrent requests — and the SSE watcher firing on the
 * same log change that woke a request — share one in-flight pass rather than racing to
 * append the same records. {@link RECONCILE_MIN_INTERVAL_MS} bounds it further: every
 * proxied request writes into `logs/`, so the watch ticks are continuous and without a
 * floor the scan would run back to back forever. A failure is swallowed: the store is a
 * cache of the logs, and serving it slightly stale beats 500-ing the page.
 *
 * The pass's appends are then folded into the substrate's command tables, inside that
 * same shared promise, so the next read answers from rows rather than re-parsing the
 * store this pass just wrote to. See {@link syncCommandRows}.
 */
let reconciling: Promise<void> | null = null;
let reconciledAt = 0;

/** The floor between two reconcile passes. See {@link reconcileCommands}. */
const RECONCILE_MIN_INTERVAL_MS = 15_000;

function reconcileCommands(force = false): Promise<void> {
  if (!force && !reconciling && Date.now() - reconciledAt < RECONCILE_MIN_INTERVAL_MS) return Promise.resolve();
  reconciling ??= reconcileCommandRuns(LOG_DIR, COMMANDS_DIR)
    .then(async (result) => {
      await syncCommandRows(result);
      // A copy: a listener is free to unsubscribe itself as it fires.
      if (result.appended) for (const fire of Array.from(commandStoreListeners)) fire();
    })
    .catch(() => undefined)
    .finally(() => {
      reconciledAt = Date.now();
      reconciling = null;
    });
  return reconciling;
}

/**
 * Woken when a background reconcile pass appended to the command store — what keeps the
 * command streams live now that their `build` no longer waits for the pass.
 *
 * Not `fs.watch(LOG_DIR)`: the pass writes `logs/commands/runs.jsonl`, a file in a
 * *subdirectory*, which a non-recursive watch on the log root may never report.
 */
const commandStoreListeners = new Set<() => void>();

function onCommandStoreChange(fire: () => void): () => void {
  commandStoreListeners.add(fire);
  return () => {
    commandStoreListeners.delete(fire);
  };
}

/**
 * Hand the reconcile's own appends to the substrate, so the command tables are level
 * with the store before the route reads them back.
 *
 * The **substrate**, not `readSource()`: under `DB_READS=0` the files answer and the
 * substrate is the shadow, and a shadow whose rows are stale reports differences that
 * are its own. Both sides want the rows current.
 *
 * Best-effort. A substrate that never opened, a backing with no rows to move, a pass
 * that appended nothing, or rows the append cannot safely fold into all end here
 * doing nothing, and `readCommandRuns` falls back to the file read.
 */
async function syncCommandRows(result: ReconcileResult): Promise<void> {
  if (!result.appended) return;
  const substrate = substrateSource();
  if (!substrate?.syncCommandRuns) return;
  await substrate.syncCommandRuns(LOG_DIR, result.appended);
}

/** Build now, reconcile behind — see {@link reconcileCommands} for why it is not awaited. */
function withCommandReconcile<T>(build: () => Promise<T>): Promise<T> {
  void reconcileCommands();
  return build();
}

/**
 * The one case a read still waits for a pass: the record asked for is not on file.
 *
 * A list route has a degraded answer — one fewer row, filled in by the pass behind it. A
 * detail route addressed at a single run has none, so a miss, and only a miss, forces a
 * pass and asks once more. A genuine 404 pays for one scan and still 404s.
 */
async function afterReconcileIfMissing<T>(build: () => Promise<T>, missing: string): Promise<T> {
  try {
    return await build();
  } catch (err) {
    if (!errorMessage(err).startsWith(missing)) throw err;
    await reconcileCommands(true);
    return build();
  }
}

/**
 * Shadow mode: the response has already been sent; ask the backing it did *not*
 * come from the same question and log any disagreement.
 *
 * Normally that is the file scan checking the substrate, and the substrate
 * checking the files under `DB_READS=0`.
 *
 * Off unless `SHADOW_DB=1`. It cannot change what was served: the send has
 * happened, the comparison is a later tick, and `shadowCheck` swallows its own
 * failures. Callers hand both sides the identical `now`, so a clock tick cannot
 * masquerade as a mismatch.
 */
function shadow<T>(label: string, served: T, build: (source: SidecarSource) => Promise<T>): void {
  const other = shadowSource();
  if (!other) return;
  shadowCheck(label, served, () => build(other), readSource().kind);
}

/**
 * A set of response headers, lower-cased name to value — the shape `writeHead` takes
 * and the one every CORS block here is. Named because it is a contract between these
 * helpers rather than an incidental dictionary.
 */
interface HeaderMap {
  [name: string]: string;
}

/** Everything but the chat routes is a read-only view of already-captured logs. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

/**
 * Origins allowed to POST the write routes — the dashboard's dev server by default,
 * overridable with a comma-separated `CHAT_ALLOWED_ORIGINS`.
 *
 * They cannot share the read-only `*`: a POST here can start an agent turn, which runs
 * commands in this checkout. A request that *declares* another origin is refused
 * outright, rather than relying on the browser to withhold the response.
 *
 * Which routes those are is not restated here: `API_ROUTES` declares each route's `cors`
 * and methods, and `isApiWriteRoute` reads the allowlist back off them.
 */
const CHAT_ORIGINS = (process.env.CHAT_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const originAllowed = (origin: string | undefined): boolean => !origin || CHAT_ORIGINS.includes(origin);

function chatCors(origin: string | undefined): HeaderMap {
  const headers: HeaderMap = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    // The answer depends on the request's origin, so a cache must not reuse it across them.
    vary: 'origin',
  };
  if (origin && CHAT_ORIGINS.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

/** Below this, a gzip frame plus the deflate costs more than the bytes it saves. */
const COMPRESS_MIN_BYTES = 1024;

/** Whether the request will take a gzip body. `gzip;q=0` says it will not. */
function acceptsGzip(req: http.IncomingMessage): boolean {
  const raw = req.headers['accept-encoding'];
  const header = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  for (const part of header.split(',')) {
    const [token, ...params] = part.split(';').map((p) => p.trim().toLowerCase());
    if (token !== 'gzip' && token !== '*') continue;
    const q = params.find((p) => p.startsWith('q='));
    return !(q && Number(q.slice(2)) === 0);
  }
  return false;
}

/**
 * Weak-compare an `If-None-Match` list against this response's tag. Weak because the
 * tag hashes the serialized JSON, so an identity answer and a gzipped one are one
 * representation.
 */
function etagMatches(req: http.IncomingMessage, etag: string): boolean {
  const raw = req.headers['if-none-match'];
  if (!raw) return false;
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (header.trim() === '*') return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => bare(tag) === bare(etag));
}

/**
 * The one place a JSON body goes out, and so the one place a repeated poll can be
 * answered without re-sending it.
 *
 * A 200 answering a read carries a weak ETag over the serialized body and
 * `cache-control: no-cache`; a matching `If-None-Match` gets a 304 with the validator
 * and the CORS headers, no body and no `content-length`. `immutable` swaps that header
 * for {@link IMMUTABLE_CACHE_CONTROL}. A body over {@link COMPRESS_MIN_BYTES} the request
 * accepts gzip for goes out compressed.
 *
 * The bytes hashed are the bytes a route already produced, so parity comparisons keep
 * seeing identical payloads. Server-sent events never come through here — `serveSse`
 * writes its own `no-cache` headers and stays uncompressed.
 *
 * `res.req` is the request this response answers, so the negotiation needs no `req`
 * threaded through every call site.
 */
/**
 * A year, and `immutable`: what a response the server vouches will never change again is
 * answered with, so a browser holding it re-asks for nothing — not even a revalidating
 * `If-None-Match`.
 *
 * **Only a route that already knows the answer has settled may pass it**, and the bar is
 * higher than "the day is closed". Nothing here is content-addressed, so a browser told
 * this cannot be reached again by any server-side invalidation — the entry has to be
 * unreachable *by construction*. Today one route clears that: `/api/context/day`, for a
 * closed reporting day the corpus actually holds requests for. An empty past day does
 * not qualify, because it is only empty until an archive restore or an ADR-0004 rebuild
 * (`rm logs/claude-proxy.db && pnpm --filter server ingest`) gives it content. Everything
 * else stays `no-cache`, where the ETag already makes a repeat poll nearly free.
 */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * The uncompressed body size each response wrote, for the observation taken once it has
 * been served.
 *
 * Set only where a body is actually written, so a 304 — the ETag path, no body at all —
 * records nothing, and neither does an SSE subscription: those write their frames directly
 * and never reach {@link send}.
 */
const servedBytes = new WeakMap<http.ServerResponse, number>();

/**
 * Record what one served response cost: the route it answered, how long it took, and how
 * large the answer was.
 *
 * **Both readings are taken after the response is served**, from the `finish` event. The
 * duration would otherwise have to stop before the size was known, or include the weighing
 * of the very answer it is judging — and `send` already had the byte length in hand, so
 * nothing here serializes, diffs, or re-reads anything.
 *
 * Only a **200 that wrote a body** is recorded. A 304 measures the ETag comparison rather
 * than the work, and a 404, 405 or 500 measures a rejection; folding either into a route's
 * median would make the gate looser exactly where the route got slower.
 *
 * What `finish` includes, and the fixture's one standing assumption: the event fires once
 * the last chunk has been flushed to the socket, so a multi-megabyte answer's duration
 * carries however long the client took to accept it. On the loopback the dashboard records
 * against, that is nothing; served to a slow consumer, a large route's median can cross its
 * allowance with nothing having regressed. Stopping the clock earlier is not the fix — it
 * would have to stop before the size is known — so a breach on one of the megabyte routes
 * is read against the link it was recorded over before it is read as a regression.
 */
function observeServedRoute(route: string, res: http.ServerResponse, startedAt: number): void {
  const bytes = servedBytes.get(res);
  if (bytes === undefined || res.statusCode !== 200) return;
  recordRouteObservation(LOG_DIR, { route, durationMs: performance.now() - startedAt, bytes });
}

function send<T>(res: http.ServerResponse, status: number, body: T, cors: HeaderMap = CORS, immutable = false): void {
  const req = res.req;
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  const headers: HeaderMap = {
    'content-type': 'application/json',
    ...cors,
    // Appended rather than overwritten: the chat CORS path already varies on `origin`.
    vary: cors.vary ? `${cors.vary}, accept-encoding` : 'accept-encoding',
  };

  // Only where a cache entry can exist: a 200 answering a read. An error body gets no
  // validator.
  if (status === 200 && (req.method === 'GET' || req.method === 'HEAD')) {
    const etag = `W/"${crypto.createHash('sha1').update(json).digest('base64url')}"`;
    headers.etag = etag;
    headers['cache-control'] = immutable ? IMMUTABLE_CACHE_CONTROL : 'no-cache';
    if (etagMatches(req, etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }

  const write = (payload: Buffer, encoding?: string): void => {
    // The observation's byte reading, off the buffer already built — never a second
    // serialization. Read back in `observeServedRoute` once the response has gone out.
    servedBytes.set(res, json.length);
    if (encoding) headers['content-encoding'] = encoding;
    headers['content-length'] = String(payload.length);
    res.writeHead(status, headers);
    res.end(payload);
  };

  if (json.length < COMPRESS_MIN_BYTES || !acceptsGzip(req)) {
    write(json);
    return;
  }

  // Async rather than `gzipSync`: the graph payload is megabytes. A failed deflate
  // still answers, uncompressed.
  zlib.gzip(json, (err, gzipped) => {
    if (res.writableEnded) return;
    if (err) write(json);
    else write(gzipped, 'gzip');
  });
}

const SSE_BASE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
};

/** Comment-frame heartbeat interval — keeps proxies/browsers from idling out. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * A resource that changes on disk: re-read it when the path does.
 *
 * `T` is whatever payload this stream's `build` produces — the same value the
 * matching non-streaming route sends, so the two cannot describe different shapes.
 */
interface SseWatchSource<T> {
  /** File or directory to `fs.watch`; a change re-runs `build` and pushes an update. */
  watchPath: string;
  /**
   * Produce the JSON payload sent as the initial `snapshot` and each `update`.
   *
   * `scope` names the reporting days this tick's fs events touched, and is
   * `null` — **rebuild everything** — for the opening snapshot and for any
   * change that maps to no day. A builder that cannot narrow itself ignores it.
   *
   * Resolving `null` means this tick's days cannot have moved the payload:
   * nothing is sent and the client keeps what it has.
   */
  build: (scope: RebuildScope) => Promise<T>;
  /** Coalesce bursts of fs events within this window (ms) before rebuilding. */
  debounceMs: number;
  /**
   * A second trigger, for a change this process witnesses but `watchPath` will not
   * report — a background pass writing under a subdirectory, say. Registered like a push
   * source's `subscribe` and returning the same unsubscribe. It carries no payload: the
   * tick runs through `build` and the dedupe as an fs event does, and is unscoped.
   */
  notify?: (fire: () => void) => () => void;
}

/**
 * A resource that is pushed rather than polled: the server already knows the change as
 * it happens and has nothing to re-read. Frames are sent exactly as produced — never
 * deduped, because two identical pushes are two real events, not a repeat of one.
 */
interface SsePushSource<T> {
  /** The value sent as the opening `snapshot`. */
  snapshot: () => T | Promise<T>;
  /** Register for pushes; each one is sent as an `update`. Returns the unsubscribe. */
  subscribe: (push: (frame: T) => void) => () => void;
}

/**
 * A resource that lives somewhere this process cannot watch: re-read it on a
 * timer and send an `update` only when the payload actually changed.
 *
 * This exists for the hosted ideas ledger (ADR 0006), which has no file to
 * `fs.watch` once it is a database on a Worker. **Polling with a diff is the
 * whole mechanism, deliberately** — a Durable Object or a WebSocket would push
 * instead, at the cost of the per-connection state ADR 0005 rejected outright,
 * to serve a dashboard list. The dedupe means an idle ledger costs one request
 * per interval and sends nothing, and the SSE contract a client sees is
 * identical to the watch source's.
 */
interface ScheduledPollSource<T> {
  build: () => Promise<T>;
  /** How often to re-read. Slower than a watch debounce, since each tick is a network call. */
  intervalMs: number;
}

type SseStream<T> = (SseWatchSource<T> | SsePushSource<T> | ScheduledPollSource<T>) & {
  /**
   * Response CORS. Defaults to the read routes' open `*`, which is only right for a
   * payload every other reader may see — a stream carrying chat content passes the
   * origin-checked headers instead.
   */
  cors?: HeaderMap;
};

/**
 * Coalescing window for a burst of capture writes. The proxy writes three files per
 * request, back to back, and the numbers barely move between two of them.
 */
const CAPTURE_DEBOUNCE_MS = 600;

/**
 * **The seam every stream that follows captures subscribes to: a capture landing in
 * `logs/`.**
 *
 * No new notification mechanism, deliberately — the proxy writes its per-request triple
 * straight into the log directory, so `fs.watch(LOG_DIR)` already witnesses every capture,
 * which is why `/api/summary/stream` and `/api/usage/stream` have always watched that path.
 * What this adds is the *name*, so a route following captures does not re-decide the watch
 * path and the debounce and drift from its neighbours. A background pass writing under a
 * *subdirectory* is what it does not cover; `notify` and {@link onCommandStoreChange} are
 * for that.
 *
 * `build` takes the tick's {@link RebuildScope} — the reporting days those files touched —
 * and answers `null` for a tick that cannot have moved its payload.
 */
function captureStream<T>(build: (scope: RebuildScope) => Promise<T | null>): SseStream<T | null> {
  return { watchPath: LOG_DIR, build, debounceMs: CAPTURE_DEBOUNCE_MS };
}

/**
 * A concepts stream, watching the log directory only when the local file is the
 * backing store. `logs/` takes a write per proxied request and none of them say
 * anything about the hosted store, so a remote-backed watch would refetch the
 * whole corpus every debounce tick, per client, and drop each answer as
 * unchanged. A remote-backed page refreshes on the next load instead.
 */
function conceptsStream<T>(build: () => Promise<T>): SseStream<T> {
  // Nothing local to subscribe to: the snapshot and the heartbeat are the whole stream.
  if (remoteConceptStore()) return { snapshot: build, subscribe: () => () => undefined };
  return { watchPath: LOG_DIR, build, debounceMs: 600 };
}

/**
 * Serve one live JSON resource over Server-Sent Events. Sends the current value as a
 * `snapshot` event, then `update` events as it changes. A comment heartbeat keeps the
 * connection open, and everything is torn down when the client disconnects.
 *
 * Two sources feed it. A **watch** source re-runs `build` whenever `watchPath` changes
 * on disk, deduping byte-identical payloads — the shape every dashboard list uses. A
 * **push** source is handed a callback and pushes frames itself, for something the
 * server witnesses rather than reads back, such as a chat turn in flight.
 *
 * The initial snapshot is produced *before* the SSE headers, so a failure surfaces as a
 * normal HTTP error (400/404/500) that `EventSource` reports without reconnecting.
 */
async function serveSse<T>(req: http.IncomingMessage, res: http.ServerResponse, stream: SseStream<T>): Promise<void> {
  const cors = stream.cors ?? CORS;
  const watch = 'watchPath' in stream ? stream : null;
  const poll = 'intervalMs' in stream ? stream : null;
  const push = 'subscribe' in stream ? stream : null;

  // Assigned by whichever of the three branches below matched, and the union those
  // three make up is the whole of `SseStream`.
  let snapshot: T | undefined;
  try {
    // `null`: the opening snapshot has no change to be scoped to, and is always full.
    if (watch) snapshot = await watch.build(null);
    else if (poll) snapshot = await poll.build();
    else if (push) snapshot = await push.snapshot();
  } catch (err) {
    const msg = errorMessage(err);
    // A configured concept store that will not answer is a 502 here too.
    if (err instanceof RemoteConceptStoreError) send(res, 502, { error: msg }, cors);
    else if (err instanceof RemoteIdeasStoreError) send(res, 502, { error: msg }, cors);
    else if (err instanceof IdeasStoreUnconfiguredError) send(res, 501, { error: msg }, cors);
    else send(res, /(^|\b)not found:/.test(msg) ? 404 : 500, { error: msg }, cors);
    return;
  }

  res.writeHead(200, { ...SSE_BASE_HEADERS, ...cors });
  let lastSent = JSON.stringify(snapshot);
  res.write(`event: snapshot\ndata: ${lastSent}\n\n`);

  let debounce: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let unsubscribe: (() => void) | null = null;

  if (watch) {
    // File names seen since the last rebuild. A `null` entry is an event
    // `fs.watch` could not name, and taints the tick into a full rebuild.
    let touched: (string | null)[] = [];

    const pushUpdate = () => {
      debounce = null;
      const scope = rebuildScope(touched);
      touched = [];
      watch
        .build(scope)
        .then((data) => {
          if (res.writableEnded) return;
          // The builder answered "this tick's days cannot have moved me".
          if (data === null) return;
          const next = JSON.stringify(data);
          if (next === lastSent) return; // spurious fs event or no-op change
          lastSent = next;
          res.write(`event: update\ndata: ${next}\n\n`);
        })
        .catch(() => {
          /* transient read error mid-write — skip this tick; the next change re-reads */
        });
    };

    try {
      watcher = fs.watch(watch.watchPath, (_event, filename) => {
        // `fs.watch` does not always deliver a name, and gives a Buffer under a
        // non-default encoding; either way the change cannot be placed on a day.
        touched.push(Buffer.isBuffer(filename) ? null : (filename ?? null));
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(pushUpdate, watch.debounceMs);
      });
      // biome-ignore lint/suspicious/noEmptyBlockStatements: swallowing it is the handling — watch dropped (e.g. file removed), and snapshot + heartbeat still hold
      watcher.on('error', () => {});
    } catch {
      /* watch unsupported / path missing — client keeps the snapshot, heartbeat holds it open */
    }

    // Coalesced through the same debounce as an fs event; the `null` taints the tick into
    // a full rebuild, since this change was never placed on a day.
    if (watch.notify) {
      unsubscribe = watch.notify(() => {
        touched.push(null);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(pushUpdate, watch.debounceMs);
      });
    }
  } else if (poll) {
    // Same dedupe the watch source does, for the same reason: a tick that reads
    // an unchanged ledger must be indistinguishable, to the client, from no tick.
    const timer = setInterval(() => {
      poll
        .build()
        .then((data) => {
          if (res.writableEnded) return;
          const next = JSON.stringify(data);
          if (next === lastSent) return;
          lastSent = next;
          res.write(`event: update\ndata: ${next}\n\n`);
        })
        .catch(() => {
          /* the ledger was unreachable this tick — the client keeps what it has and the next tick re-reads */
        });
    }, poll.intervalMs);
    unsubscribe = () => clearInterval(timer);
  } else if (push) {
    // Subscribed after the snapshot was written, so the opening frame and the pushes
    // cannot interleave and the client never sees an update it has no baseline for.
    unsubscribe = push.subscribe((frame) => {
      if (res.writableEnded) return;
      res.write(`event: update\ndata: ${JSON.stringify(frame)}\n\n`);
    });
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n');
  }, SSE_HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
    watcher = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Parse `?days=` as a positive int in [1, 365], default 14 — plus `all`, and the
 * `0` the picker sends for it, meaning every day on record.
 *
 * All-time is resolved to a concrete count here, once per request, off the
 * backing's own floor. That is what keeps the 365 ceiling honest: it clamps a
 * number a caller *asked* for, and no longer decides how far back the corpus is
 * allowed to be read.
 */
async function parseDays(raw: string | null, now: Date = new Date()): Promise<number> {
  const text = raw?.trim() ?? '';
  if (text === '') return 14;
  const n = Number(text);
  if (text.toLowerCase() === 'all' || n === ALL_DAYS) {
    return resolveAllDays(LOG_DIR, ALL_DAYS, now, readSource(), ARCHIVE_DIR);
  }
  if (!Number.isFinite(n)) return 14;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

/**
 * The `?models=` filter: a comma-separated list of model ids, or nothing at all. An
 * absent, blank, or all-blank list reads as no filter rather than one matching nothing.
 */
function parseModels(raw: string | null): string[] | undefined {
  const names = (raw ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');
  return names.length > 0 ? names : undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(raw: string | null): string | undefined {
  return raw && DATE_RE.test(raw) ? raw : undefined;
}

const MAX_BODY_BYTES = 1_000_000;

async function readJsonBody(req: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // SAFETY: nothing calls `req.setEncoding()` on this request and the server never puts
  // it in object mode, so the request stream stays in its default binary mode — where
  // every chunk a `Readable` yields is a Buffer.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error(`request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  const parsed = parseJson(Buffer.concat(chunks).toString('utf8'));
  if (parsed === undefined) throw new Error('request body is not valid JSON');
  // `null`, an array and every primitive land here: none of them has fields to read.
  const body = jsonObject(parsed);
  if (body === undefined) throw new Error('request body must be a JSON object');
  return body;
}

/** Map a chat failure onto a status. */
function chatErrorStatus(msg: string): number {
  if (msg.startsWith('chat session not found')) return 404;
  if (msg.startsWith('chat is not configured')) return 503;
  if (
    msg.startsWith('chat request') ||
    msg.startsWith('chat cli') ||
    msg.startsWith('claude cli') ||
    msg.startsWith('anthropic stream error')
  ) {
    return 502;
  }
  return 400; // invalid prompt / missing sessionId / malformed body
}

/**
 * A rejected save is the body's fault; anything else — a permission error, a full
 * disk — is the server's, and a 400 would send the editor looking for a typo. A
 * stale save is neither: the request was well-formed and the file simply moved
 * under it, which is a 409 for the editor to re-read and show.
 */
function systemPromptErrorStatus(msg: string): number {
  if (msg.startsWith('system prompt changed on disk')) return 409;
  return /^(system prompt text|system prompt expectedModified|request body)\b/.test(msg) ? 400 : 500;
}

/**
 * Moving `main` fails in four distinguishable ways, and the page acts differently on
 * each: an identity that may not do it, a page that had gone stale, a request that is
 * simply wrong, and a preflight that said no.
 */
function mainHistoryErrorStatus(msg: string): number {
  if (msg.startsWith(ERR.notAuthorized)) return 403;
  if (msg.startsWith(ERR.moved)) return 409;
  if (msg.startsWith(ERR.bad)) return 400;
  if (msg.startsWith(ERR.refused)) return 409;
  return 500;
}

/**
 * A POST route: the same origin check, method check and JSON body the chat routes
 * have, with the failure→status mapping left to the caller since each write
 * surface fails in its own vocabulary.
 */
async function servePost<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: JsonObject) => Promise<T>,
  errorStatus: (msg: string) => number = chatErrorStatus,
): Promise<void> {
  const origin = req.headers.origin;
  const cors = chatCors(origin);
  if (!originAllowed(origin)) {
    send(res, 403, { error: `origin not allowed: ${origin}` }, cors);
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: `method not allowed: ${req.method}` }, cors);
    return;
  }
  try {
    send(res, 200, await handler(await readJsonBody(req)), cors);
  } catch (err) {
    const msg = errorMessage(err);
    send(res, errorStatus(msg), { error: msg }, cors);
  }
}

function notesError(res: http.ServerResponse, cause: unknown, cors: HeaderMap = CORS): void {
  if (cause instanceof NotesStoreUnconfiguredError) send(res, 501, { error: cause.message }, cors);
  else if (cause instanceof RemoteNotesResponseError) send(res, cause.status, cause.body, cors);
  else if (cause instanceof RemoteNotesStoreError) send(res, 502, { error: cause.message }, cors);
  else send(res, 400, { error: errorMessage(cause) }, cors);
}

function notesListQuery(url: URL): NoteListQuery {
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error('limit must be a positive integer');
  const archivedRaw = url.searchParams.get('archived');
  if (archivedRaw !== null && archivedRaw !== 'true' && archivedRaw !== 'false') {
    throw new Error('archived must be true or false');
  }
  return {
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit,
    archived: archivedRaw === null ? undefined : archivedRaw === 'true',
  };
}

async function serveNotesList({ req, res, url }: RouteContext, stream: boolean): Promise<void> {
  try {
    const options = notesListQuery(url);
    const build = async () => (await listRemoteNotes(requireRemoteNotesStore(), options)).body;
    if (stream) await serveSse(req, res, { build, intervalMs: NOTES_POLL_MS });
    else send(res, 200, await build());
  } catch (error) {
    notesError(res, error);
  }
}

async function serveNoteWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: JsonObject) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const origin = req.headers.origin;
  const cors = chatCors(origin);
  if (!originAllowed(origin)) {
    send(res, 403, { error: `origin not allowed: ${origin}` }, cors);
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: `method not allowed: ${req.method}` }, cors);
    return;
  }
  try {
    const reply = await handler(await readJsonBody(req));
    send(res, reply.status, reply.body, cors);
  } catch (error) {
    notesError(res, error, cors);
  }
}

/** What every handler is handed: the request, the response, and the parsing they share. */
interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** `?date=`, when it is a real `YYYY-MM-DD` — the day parameter the digests take. */
  date: string | undefined;
}

type RouteHandler = (ctx: RouteContext) => Promise<void>;

/**
 * One command's page and the stream that pushes the same payload: two routes in the
 * manifest, one body here, because only the delivery differs.
 */
async function serveCommandDetail({ req, res, url }: RouteContext, stream: boolean): Promise<void> {
  const name = url.searchParams.get('name');
  if (!name) {
    send(res, 400, { error: 'missing ?name=' });
    return;
  }
  const flags = (url.searchParams.get('flags') ?? '').split(',').filter(Boolean);
  const build = () => withCommandReconcile(() => buildCommand(LOG_DIR, COMMANDS_DIR, name, flags, readSource()));
  if (stream) {
    await serveSse(req, res, { watchPath: LOG_DIR, build, debounceMs: 600, notify: onCommandStoreChange });
    return;
  }
  try {
    const command = await afterReconcileIfMissing(build, 'command not found');
    send(res, 200, command);
    shadow('/api/commands/command', command, (source) => buildCommand(LOG_DIR, COMMANDS_DIR, name, flags, source));
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.startsWith('command not found')) send(res, 404, { error: msg });
    else throw err;
  }
}

/** One run, and its stream — the same pairing. */
async function serveCommandRun({ req, res, url }: RouteContext, stream: boolean): Promise<void> {
  const id = url.searchParams.get('id');
  if (!id) {
    send(res, 400, { error: 'missing ?id=' });
    return;
  }
  const build = () => withCommandReconcile(() => buildCommandRun(LOG_DIR, id, readSource()));
  if (stream) {
    await serveSse(req, res, { watchPath: LOG_DIR, build, debounceMs: 600, notify: onCommandStoreChange });
    return;
  }
  try {
    const run = await afterReconcileIfMissing(build, 'command run not found');
    send(res, 200, run);
    shadow('/api/commands/run', run, (source) => buildCommandRun(LOG_DIR, id, source));
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.startsWith('command run not found')) send(res, 404, { error: msg });
    else throw err;
  }
}

/**
 * One concept, addressed by the line it sits on. The store is append-only, so that
 * line keeps pointing at the same record as newer ones land above it on the page.
 */
async function serveConcept({ req, res, url }: RouteContext, stream: boolean): Promise<void> {
  const ord = Number(url.searchParams.get('ord'));
  if (!Number.isInteger(ord) || ord < 0) {
    send(res, 400, { error: 'missing or invalid ?ord=' });
    return;
  }
  const build = () => buildConcept(LOG_DIR, ord, readSource());
  if (stream) {
    await serveSse(req, res, conceptsStream(build));
    return;
  }
  try {
    const concept = await build();
    send(res, 200, concept);
    if (concept.meta.store === 'local') {
      shadow('/api/concepts/concept', concept, (source) => buildConcept(LOG_DIR, ord, source));
    }
  } catch (err) {
    const msg = errorMessage(err);
    if (err instanceof RemoteConceptStoreError) send(res, 502, { error: msg });
    else if (msg.startsWith('concept not found')) send(res, 404, { error: msg });
    else throw err;
  }
}

/** How often the ideas stream re-reads the hosted ledger. See {@link ScheduledPollSource}. */
const IDEAS_POLL_MS = 5_000;

/**
 * The ideas ledger, listed or streamed.
 *
 * **The stream polls rather than watching.** The ledger is hosted now (ADR
 * 0006), so there is no file for `fs.watch` to see change — and the writers that
 * matter are on *other machines*, which a local watch could never have seen
 * anyway. The frames a client receives are unchanged.
 */
async function serveIdeas({ req, res, url }: RouteContext, stream: boolean): Promise<void> {
  const statusParam = url.searchParams.get('status');
  const repoParam = url.searchParams.get('repo');
  const areaParam = url.searchParams.get('area');
  let statuses: IdeaStatus[] | undefined;
  try {
    if (statusParam) {
      statuses = statusParam.split(',').map((s) => {
        const status = s.trim();
        if (!isIdeaStatus(status)) throw new Error(`invalid status: ${status}`);
        return status;
      });
    }
    // A checkout path names a different thing on another machine, and this ledger
    // is shared across every repo on this one.
    if (repoParam && !isIdeaRepo(repoParam)) {
      throw new Error(`invalid repo: ${repoParam} (expected a git remote slug like owner/name)`);
    }
    // Shape only. The vocabulary is free text, so an area nothing is filed
    // under is an empty list rather than an error.
    if (areaParam && !isIdeaArea(areaParam)) {
      throw new Error(`invalid area: ${areaParam} (expected a kebab-case slug)`);
    }
  } catch (err) {
    send(res, 400, { error: errorMessage(err) });
    return;
  }
  // Each filter is set only when the query string carried one: an absent key is
  // "no filter", where a present `undefined` would be a filter matching nothing.
  const filter: IdeaFilter = {};
  if (statuses) filter.statuses = statuses;
  if (repoParam) filter.repo = repoParam;
  if (areaParam) filter.area = areaParam;
  if (stream) {
    await serveSse(req, res, { build: () => buildIdeas(filter), intervalMs: IDEAS_POLL_MS });
    return;
  }
  // No shadow read: authored state with no derived half, so there is nothing for
  // the substrate to disagree about.
  try {
    send(res, 200, await buildIdeas(filter));
  } catch (err) {
    // An unconfigured device is a 501 rather than a 500: the ledger is not
    // broken, this machine simply has no address for it, and the message says so.
    if (err instanceof IdeasStoreUnconfiguredError) send(res, 501, { error: err.message });
    else if (err instanceof RemoteIdeasStoreError) send(res, 502, { error: err.message });
    else throw err;
  }
}

/**
 * The dispatch table, keyed by the manifest's own paths.
 *
 * `Record<ApiRoutePath, RouteHandler>` is what makes `API_ROUTES` load-bearing rather
 * than documentation: a handler for a path the manifest does not declare will not
 * compile, and a declared route with no handler will not either. The `switch` this
 * replaced could drift from the route list in both directions without a word.
 *
 * **The annotation is pinned by a test and cannot become `satisfies`.**
 * `server/test/orphan-surface.test.ts` reads this file as *text* and looks for the
 * literal `const HANDLERS: Record<ApiRoutePath, RouteHandler> = {`, then scrapes the
 * route keys out of the block up to the next `\n};` — that is how it checks the
 * dispatch table against the manifest without importing a module that starts a
 * server. `satisfies` moves the type to the closing line and renames the opening one,
 * so it defeats both halves of that scrape. Since every entry here is checked against
 * `ApiRoutePath` either way, the annotation costs nothing the `satisfies` bought.
 */
// oxlint-disable-next-line anti-slop/no-known-value-widening -- the annotation is the form `server/test/orphan-surface.test.ts` scrapes for; see above.
const HANDLERS: Record<ApiRoutePath, RouteHandler> = {
  '/api/health': async ({ res }) => {
    let sidecarCount: number | null = null;
    let logDirReadable = true;
    try {
      sidecarCount = await countSidecarFiles(LOG_DIR);
    } catch {
      logDirReadable = false;
    }
    send(res, 200, { ok: logDirReadable, logDir: LOG_DIR, logDirReadable, sidecarCount });
  },
  '/api/summary': async ({ res, date }) => {
    const now = new Date();
    const summary = await buildSummary(LOG_DIR, date, now, ARCHIVE_DIR, readSource());
    send(res, 200, summary);
    shadow('/api/summary', summary, (source) => buildSummary(LOG_DIR, date, now, ARCHIVE_DIR, source));
  },
  // Today's digest moves with every captured request, so this follows the log
  // directory rather than any one file. Every capture's name maps onto today, so
  // the day in progress still recomputes; the scope only skips a tick touching no
  // day this summary reads — outside the baseline walk, or beside a `?date=` pin.
  '/api/summary/stream': async ({ req, res, date }) => {
    await serveSse(
      req,
      res,
      captureStream((scope) => buildSummaryScoped(scope, LOG_DIR, date, new Date(), ARCHIVE_DIR, readSource())),
    );
  },
  '/api/trends': async ({ res, url }) => {
    const days = await parseDays(url.searchParams.get('days'));
    const models = parseModels(url.searchParams.get('models'));
    const now = new Date();
    const trends = await buildTrends(LOG_DIR, days, now, ARCHIVE_DIR, readSource(), models);
    send(res, 200, trends);
    shadow('/api/trends', trends, (source) => buildTrends(LOG_DIR, days, now, ARCHIVE_DIR, source, models));
  },
  '/api/prompt-mix': async ({ res, url }) => {
    const days = await parseDays(url.searchParams.get('days'));
    const now = new Date();
    const mix = await buildPromptMix(LOG_DIR, days, now, readSource());
    send(res, 200, mix);
    shadow('/api/prompt-mix', mix, (source) => buildPromptMix(LOG_DIR, days, now, source));
  },
  // One cohort from that mix, opened up — which sections its bytes are in.
  '/api/prompt': async ({ res, url }) => {
    const hash = url.searchParams.get('hash');
    if (!hash) {
      send(res, 400, { error: 'missing ?hash=' });
      return;
    }
    const days = await parseDays(url.searchParams.get('days'));
    const now = new Date();
    const detail = await buildPromptDetail(LOG_DIR, hash, days, now, readSource());
    send(res, 200, detail);
    shadow('/api/prompt', detail, (source) => buildPromptDetail(LOG_DIR, hash, days, now, source));
  },
  // One section of that prompt, with the text a captured body still holds.
  '/api/prompt/section': async ({ res, url }) => {
    const hash = url.searchParams.get('hash');
    if (!hash) {
      send(res, 400, { error: 'missing ?hash=' });
      return;
    }
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(index) || index < 0) {
      send(res, 400, { error: 'missing or invalid ?index=' });
      return;
    }
    const days = await parseDays(url.searchParams.get('days'));
    try {
      send(res, 200, await buildPromptSection(LOG_DIR, hash, index, days, new Date(), readSource()));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('prompt outline not found') || msg.startsWith('prompt section index out of range')) {
        send(res, 404, { error: msg });
      } else throw err;
    }
  },
  // One tool of the fixed prefix, opened up to the JSON schema behind its size.
  '/api/tool-schema': async ({ res, url }) => {
    const name = url.searchParams.get('name');
    if (!name) {
      send(res, 400, { error: 'missing ?name=' });
      return;
    }
    const days = await parseDays(url.searchParams.get('days'));
    const now = new Date();
    const schema = await buildToolSchema(LOG_DIR, name, days, now, readSource());
    send(res, 200, schema);
    shadow('/api/tool-schema', schema, (source) => buildToolSchema(LOG_DIR, name, days, now, source));
  },
  '/api/usage': async ({ res }) => {
    const now = new Date();
    const usage = await buildUsage(LOG_DIR, USAGE_LIMITS, now, readSource());
    send(res, 200, usage);
    shadow('/api/usage', usage, (source) => buildUsage(LOG_DIR, USAGE_LIMITS, now, source));
  },
  '/api/usage/stream': async ({ req, res }) => {
    await serveSse(
      req,
      res,
      captureStream((scope) => buildUsageScoped(scope, LOG_DIR, USAGE_LIMITS, new Date(), readSource())),
    );
  },
  '/api/tools': async ({ res, date }) => {
    const now = new Date();
    const tools = await buildTools(LOG_DIR, date, now, ARCHIVE_DIR, readSource());
    send(res, 200, tools);
    shadow('/api/tools', tools, (source) => buildTools(LOG_DIR, date, now, ARCHIVE_DIR, source));
  },
  '/api/context': async ({ res, url }) => {
    const days = await parseDays(url.searchParams.get('days'));
    // The order, the slice and the search the table asked for. Clamped rather than
    // rejected, so a hand-written query string still answers with the default view.
    const page = contextPageQuery({
      sort: url.searchParams.get('sort'),
      dir: url.searchParams.get('dir'),
      offset: url.searchParams.get('offset'),
      limit: url.searchParams.get('limit'),
      q: url.searchParams.get('q'),
    });
    const now = new Date();
    const context = await buildContext(LOG_DIR, days, now, readSource(), page);
    send(res, 200, context);
    shadow('/api/context', context, (source) => buildContext(LOG_DIR, days, now, source, page));
  },
  // One day of that window, so a browser composes 7d, 30d and All out of days it mostly
  // already holds.
  '/api/context/day': async ({ res, date }) => {
    const now = new Date();
    const day = await buildContextDay(LOG_DIR, date, now, readSource(), ARCHIVE_DIR);
    // Settled *and* non-empty: a closed day the corpus holds nothing for is empty only
    // until something puts a day there, and an `immutable` entry could never be told.
    send(res, 200, day, CORS, day.closed && day.meta.files > 0);
    shadow('/api/context/day', day, (source) => buildContextDay(LOG_DIR, date, now, source, ARCHIVE_DIR));
  },
  // The same day, pushed. `undefined` rather than a resolved date, so every rebuild
  // re-reads the clock and a subscription held past midnight follows the rollover instead
  // of pinning a day that has since closed.
  '/api/context/day/stream': async ({ req, res }) => {
    await serveSse(
      req,
      res,
      captureStream((scope) => buildContextDayScoped(scope, LOG_DIR, undefined, new Date(), readSource(), ARCHIVE_DIR)),
    );
  },
  '/api/context/thread': async ({ res, url }) => {
    const threadId = url.searchParams.get('thread');
    if (!threadId) {
      send(res, 400, { error: 'missing ?thread=' });
      return;
    }
    const days = await parseDays(url.searchParams.get('days'));
    const now = new Date();
    const thread = await buildContextThread(LOG_DIR, threadId, days, now, readSource());
    send(res, 200, thread);
    shadow('/api/context/thread', thread, (source) => buildContextThread(LOG_DIR, threadId, days, now, source));
  },
  // The same thread, pushed while it is still adding requests. `?thread=` is refused when
  // absent for the same reason the JSON route refuses it — there is no default thread —
  // and the refusal lands as a plain 400 rather than an SSE frame, since `serveSse`
  // produces its opening snapshot before it writes the stream's headers.
  //
  // `new Date()` inside the closure rather than one resolved before it, so every rebuild
  // re-reads the clock and a subscription held past midnight follows the window forward
  // instead of pinning the days it was opened on.
  '/api/context/thread/stream': async ({ req, res, url }) => {
    const threadId = url.searchParams.get('thread');
    if (!threadId) {
      send(res, 400, { error: 'missing ?thread=' });
      return;
    }
    const days = await parseDays(url.searchParams.get('days'));
    await serveSse(
      req,
      res,
      captureStream((scope) => buildContextThreadScoped(scope, LOG_DIR, threadId, days, new Date(), readSource())),
    );
  },
  '/api/context/detail': async ({ res, url }) => {
    const file = url.searchParams.get('file');
    if (!file) {
      send(res, 400, { error: 'missing ?file=' });
      return;
    }
    try {
      send(res, 200, await buildContextDetail(LOG_DIR, file));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid request file name')) send(res, 400, { error: msg });
      else if (msg.startsWith('request file not found') || msg.startsWith('request body evicted')) {
        send(res, 404, { error: msg });
      } else throw err;
    }
  },
  '/api/context/message': async ({ res, url }) => {
    const file = url.searchParams.get('file');
    if (!file) {
      send(res, 400, { error: 'missing ?file=' });
      return;
    }
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(index) || index < 0) {
      send(res, 400, { error: 'missing or invalid ?index=' });
      return;
    }
    try {
      send(res, 200, await buildContextMessage(LOG_DIR, file, index));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid request file name')) send(res, 400, { error: msg });
      else if (msg.startsWith('request file not found') || msg.startsWith('request body evicted')) {
        send(res, 404, { error: msg });
      } else if (msg.startsWith('message index out of range')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  '/api/context/tool': async ({ res, url }) => {
    const file = url.searchParams.get('file');
    if (!file) {
      send(res, 400, { error: 'missing ?file=' });
      return;
    }
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(index) || index < 0) {
      send(res, 400, { error: 'missing or invalid ?index=' });
      return;
    }
    try {
      send(res, 200, await buildContextTool(LOG_DIR, file, index));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid request file name')) send(res, 400, { error: msg });
      else if (msg.startsWith('request file not found') || msg.startsWith('request body evicted')) {
        send(res, 404, { error: msg });
      } else if (msg.startsWith('tool index out of range')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  '/api/projects': async ({ res }) => {
    send(res, 200, await buildProjects(PROJECTS_DIR));
  },
  '/api/projects/memories': async ({ res, url }) => {
    const project = url.searchParams.get('project');
    if (!project) {
      send(res, 400, { error: 'missing ?project=' });
      return;
    }
    try {
      send(res, 200, await buildProjectMemories(PROJECTS_DIR, project));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid project name')) send(res, 400, { error: msg });
      else if (msg.startsWith('project not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  '/api/projects/memory': async ({ res, url }) => {
    const project = url.searchParams.get('project');
    const name = url.searchParams.get('name');
    if (!project || !name) {
      send(res, 400, { error: 'missing ?project= or ?name=' });
      return;
    }
    try {
      send(res, 200, await buildMemory(PROJECTS_DIR, project, name));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid project name') || msg.startsWith('invalid memory file name')) {
        send(res, 400, { error: msg });
      } else if (msg.startsWith('project not found') || msg.startsWith('memory file not found')) {
        send(res, 404, { error: msg });
      } else throw err;
    }
  },
  // The device's background jobs: `~/.claude/jobs`. Reads are open like their
  // neighbours; the delete below is the one route here that changes the disk.
  '/api/jobs': async ({ res }) => {
    send(res, 200, await buildJobs(JOBS_DIR, LOG_DIR, new Date(), readSource()));
  },
  '/api/jobs/job': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      send(res, 200, await buildJob(JOBS_DIR, id));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid job id')) send(res, 400, { error: msg });
      else if (msg.startsWith('job not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  '/api/jobs/file': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    const file = url.searchParams.get('file');
    if (!id || !file) {
      send(res, 400, { error: 'missing ?id= or ?file=' });
      return;
    }
    try {
      send(res, 200, await buildJobFile(JOBS_DIR, id, file));
    } catch (err) {
      const msg = errorMessage(err);
      if (
        msg.startsWith('invalid job id') ||
        msg.startsWith('invalid job file path') ||
        msg.startsWith('job file is a directory')
      ) {
        send(res, 400, { error: msg });
      } else if (msg.startsWith('job not found') || msg.startsWith('job file not found')) {
        send(res, 404, { error: msg });
      } else throw err;
    }
  },
  // Removes the directory for real. POST only, and through the origin-checked
  // write CORS rather than the read routes' `*`.
  '/api/jobs/delete': async ({ req, res }) => {
    await servePost(
      req,
      res,
      async (body) => {
        const id = jsonString(body.id);
        if (id === undefined || id === '') throw new Error('missing id');
        return buildJobDelete(JOBS_DIR, LOG_DIR, id, new Date(), readSource());
      },
      (msg) => {
        if (msg.startsWith('job not found')) return 404;
        if (msg.startsWith('job is still running')) return 409;
        return 400; // invalid/missing id, or a symlinked directory
      },
    );
  },
  '/api/sessions': async ({ res }) => {
    const sessions = await buildSessions(LOG_DIR, readSource());
    send(res, 200, sessions);
    shadow('/api/sessions', sessions, (source) => buildSessions(LOG_DIR, source));
  },
  '/api/sessions/stream': async ({ req, res }) => {
    await serveSse(req, res, {
      watchPath: resolveSessionsDir(LOG_DIR),
      build: () => buildSessions(LOG_DIR, readSource()),
      debounceMs: 400,
    });
  },
  '/api/sessions/session/stream': async ({ req, res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    let file: string;
    try {
      file = resolveSessionFile(LOG_DIR, id);
    } catch (err) {
      send(res, 400, { error: errorMessage(err) });
      return;
    }
    await serveSse(req, res, {
      watchPath: file,
      build: () => buildSession(LOG_DIR, id, readSource()),
      debounceMs: 150,
    });
  },
  '/api/sessions/graph': async ({ res }) => {
    // One `now` for both runs — a shadow read a moment later would otherwise diff
    // against the primary on the clock alone.
    const now = new Date();
    const graph = await buildSessionsGraph(LOG_DIR, now, readSource());
    send(res, 200, graph);
    shadow('/api/sessions/graph', graph, (source) => buildSessionsGraph(LOG_DIR, now, source));
  },
  // Every branch's liveness verdict and nothing else — thin enough to poll from a shell.
  '/api/sessions/liveness': async ({ res }) => {
    const now = new Date();
    const liveness = await buildSessionsLiveness(LOG_DIR, now, readSource());
    send(res, 200, liveness);
    shadow('/api/sessions/liveness', liveness, (source) => buildSessionsLiveness(LOG_DIR, now, source));
  },
  '/api/sessions/node-text': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      const texts = await buildSessionNodeTexts(LOG_DIR, id, readSource());
      send(res, 200, texts);
      shadow('/api/sessions/node-text', texts, (source) => buildSessionNodeTexts(LOG_DIR, id, source));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid session id')) send(res, 400, { error: msg });
      else throw err;
    }
  },
  '/api/sessions/graph/nodes': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      const now = new Date();
      const nodes = await buildSessionGraphNodes(LOG_DIR, id, now, readSource());
      send(res, 200, nodes);
      shadow('/api/sessions/graph/nodes', nodes, (source) => buildSessionGraphNodes(LOG_DIR, id, now, source));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid session id')) send(res, 400, { error: msg });
      else if (msg.startsWith('session not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  '/api/sessions/session': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      const session = await buildSession(LOG_DIR, id, readSource());
      send(res, 200, session);
      shadow('/api/sessions/session', session, (source) => buildSession(LOG_DIR, id, source));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid session id')) send(res, 400, { error: msg });
      else if (msg.startsWith('session not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  '/api/sessions/breakdown': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      const now = new Date();
      const breakdown = await buildSessionBreakdown(LOG_DIR, id, now, readSource());
      send(res, 200, breakdown);
      shadow('/api/sessions/breakdown', breakdown, (source) => buildSessionBreakdown(LOG_DIR, id, now, source));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid session id')) send(res, 400, { error: msg });
      else if (msg.startsWith('session not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  // The Commands eval page. Every read reconciles first, so the store is current
  // even on a cold server, and the streams follow a run as it happens.
  '/api/commands': async ({ res }) => {
    // The shadow read deliberately skips `withCommandReconcile`: the served
    // read already reconciled, and reconciling twice would write again. Both
    // sides then read the store that write produced — the DB side through
    // `readCommandRuns`'s watermark check, which re-reads the file until
    // ingest catches up.
    const commands = await withCommandReconcile(() => buildCommands(LOG_DIR, COMMANDS_DIR, readSource()));
    send(res, 200, commands);
    shadow('/api/commands', commands, (source) => buildCommands(LOG_DIR, COMMANDS_DIR, source));
  },
  '/api/commands/stream': async ({ req, res }) => {
    await serveSse(req, res, {
      watchPath: LOG_DIR,
      build: () => withCommandReconcile(() => buildCommands(LOG_DIR, COMMANDS_DIR, readSource())),
      debounceMs: 600,
      notify: onCommandStoreChange,
    });
  },
  '/api/commands/command': (ctx) => serveCommandDetail(ctx, false),
  '/api/commands/command/stream': (ctx) => serveCommandDetail(ctx, true),
  '/api/commands/run': (ctx) => serveCommandRun(ctx, false),
  '/api/commands/run/stream': (ctx) => serveCommandRun(ctx, true),
  // The Concepts page. With `CONCEPTS_URL` and `CONCEPTS_TOKEN` set this
  // reads the hosted store; without them, `logs/concepts.jsonl` as before.
  // `meta.storePath` says which of the two answered.
  //
  // The stream watches the log dir, since `/teach` appends to the local
  // store from outside this process. That watch says nothing about the
  // hosted store — a remote-backed page refreshes on the next local change
  // or the next load.
  '/api/concepts': async ({ res }) => {
    let concepts: Awaited<ReturnType<typeof buildConcepts>>;
    try {
      concepts = await buildConcepts(LOG_DIR, readSource());
    } catch (err) {
      // A configured hosted store that will not answer is a bad gateway,
      // never a quiet fall back to the local file's corpus.
      if (err instanceof RemoteConceptStoreError) {
        send(res, 502, { error: err.message });
        return;
      }
      throw err;
    }
    send(res, 200, concepts);
    // Shadow mode compares the two *local* backings; a remote answer came
    // from neither.
    if (concepts.meta.store === 'local') {
      shadow('/api/concepts', concepts, (source) => buildConcepts(LOG_DIR, source));
    }
  },
  '/api/concepts/stream': async ({ req, res }) => {
    await serveSse(
      req,
      res,
      conceptsStream(() => buildConcepts(LOG_DIR, readSource())),
    );
  },
  '/api/concepts/concept': (ctx) => serveConcept(ctx, false),
  '/api/concepts/concept/stream': (ctx) => serveConcept(ctx, true),
  // Searching that corpus by its prose: a proxy over the hosted store's bm25 route when
  // one is configured, a substring scan of the same fields otherwise, which `ranked`
  // reports. A store that will not answer is a 502, as on the list route — an empty
  // result set reads as a corpus that holds nothing.
  '/api/concepts/search': async ({ res, url }) => {
    try {
      send(res, 200, await buildConceptSearch(LOG_DIR, url.searchParams.get('q') ?? '', readSource()));
    } catch (err) {
      if (err instanceof RemoteConceptStoreError) send(res, 502, { error: err.message });
      else throw err;
    }
  },
  '/api/ideas': (ctx) => serveIdeas(ctx, false),
  '/api/ideas/stream': (ctx) => serveIdeas(ctx, true),
  // Adjudicating one. POST only, through the origin-checked write CORS.
  '/api/ideas/status': async ({ req, res }) => {
    await servePost(
      req,
      res,
      (body) => applyIdeaStatus(parseIdeaMarks(body.marks)),
      () => 400,
    );
  },
  // Re-filing one, and commenting on one. Same allowlist, same origin check.
  // Filing is **its own route rather than a field on the status write** — see
  // `applyIdeaFilings`.
  '/api/ideas/area': async ({ req, res }) => {
    await servePost(
      req,
      res,
      (body) => applyIdeaArea(parseIdeaFilings(body.filings)),
      () => 400,
    );
  },
  '/api/ideas/comment': async ({ req, res }) => {
    await servePost(
      req,
      res,
      (body) => applyIdeaComment(parseIdeaComments(body.comments)),
      () => 400,
    );
  },
  // Taking one back. Its own route rather than a `claimed` mark, because a claim must
  // name a holder a second run can recognise and a mark carries none — see
  // `applyIdeaClaim`. A live holder comes back in the body as a refusal rather than as
  // a status, so only a malformed request is a 400.
  '/api/ideas/claim': async ({ req, res }) => {
    await servePost(
      req,
      res,
      (body) => applyIdeaClaim(parseIdeaClaims(body.claims)),
      () => 400,
    );
  },
  '/api/notes': (ctx) => serveNotesList(ctx, false),
  '/api/notes/stream': (ctx) => serveNotesList(ctx, true),
  '/api/notes/search': async ({ res, url }) => {
    try {
      const query = url.searchParams.get('q')?.trim();
      if (!query) throw new Error('q is required');
      const page = notesListQuery(url);
      send(
        res,
        200,
        (
          await searchRemoteNotes(requireRemoteNotesStore(), {
            query,
            cursor: page.cursor,
            limit: page.limit,
          })
        ).body,
      );
    } catch (error) {
      notesError(res, error);
    }
  },
  '/api/notes/note': async ({ res, url }) => {
    try {
      const id = url.searchParams.get('id');
      if (!id) throw new Error('id is required');
      send(res, 200, (await getRemoteNote(requireRemoteNotesStore(), id)).body);
    } catch (error) {
      notesError(res, error);
    }
  },
  '/api/notes/create': async ({ req, res }) => {
    await serveNoteWrite(req, res, (body) => createRemoteNote(requireRemoteNotesStore(), parseNoteCreate(body)));
  },
  '/api/notes/update': async ({ req, res }) => {
    await serveNoteWrite(req, res, (body) => updateRemoteNote(requireRemoteNotesStore(), parseNoteUpdate(body)));
  },
  '/api/notes/archive': async ({ req, res }) => {
    await serveNoteWrite(req, res, (body) => archiveRemoteNote(requireRemoteNotesStore(), parseNoteId(body)));
  },
  '/api/notes/restore': async ({ req, res }) => {
    await serveNoteWrite(req, res, (body) => restoreRemoteNote(requireRemoteNotesStore(), parseNoteId(body)));
  },
  '/api/sessions/suggestions': async ({ res }) => {
    const suggestions = await buildSessionSuggestions(LOG_DIR, readSource());
    send(res, 200, suggestions);
    shadow('/api/sessions/suggestions', suggestions, (source) => buildSessionSuggestions(LOG_DIR, source));
  },
  '/api/sessions/suggestions/bucket': async ({ res, url }) => {
    const index = Number(url.searchParams.get('index'));
    if (!Number.isInteger(index) || index < 1) {
      send(res, 400, { error: 'missing or invalid ?index=' });
      return;
    }
    try {
      const now = new Date();
      const bucket = await buildSessionSuggestionBucket(LOG_DIR, index, now, readSource());
      send(res, 200, bucket);
      shadow('/api/sessions/suggestions/bucket', bucket, (source) =>
        buildSessionSuggestionBucket(LOG_DIR, index, now, source),
      );
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('suggestion bucket not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  // The flags on those suggestions: GET lists them, POST records them. The GET is
  // as read-only as its neighbours; the POST writes a file, so it goes through the
  // origin-checked write CORS the chat routes use — which is why the manifest gives
  // this route both methods and the narrow CORS.
  '/api/sessions/suggestions/status': async ({ req, res, url }) => {
    // Anything that isn't the GET goes through the write path, which refuses a
    // method that is neither rather than letting it fall through to the list.
    if (req.method !== 'GET') {
      await servePost(
        req,
        res,
        // The flags stay a JSON file; what goes through the seam is the
        // derived half this echoes back — the bucket/suggestion join — so
        // the response cannot describe a different corpus than the GET.
        //
        // A body carrying `judged` or `amnesty` takes the guarded judge path:
        // it refuses an unorderable corpus and an incomplete bucket.
        (body) => {
          const judging = body.judged !== undefined || body.amnesty !== undefined;
          if (!judging) {
            return applySuggestionStatus(LOG_DIR, parseSuggestionStatusUpdates(body.updates), new Date(), readSource());
          }
          const rawAmnesty = body.amnesty;
          const amnesty = jsonBoolean(rawAmnesty);
          if (rawAmnesty !== undefined && amnesty === undefined) {
            throw new Error('amnesty must be a boolean');
          }
          // Refused when present and malformed — silently dropping it would file
          // the verdict unattributed while the caller believed it had signed.
          const rawThread = body.thread;
          if (rawThread !== undefined && !isThreadId(rawThread)) {
            throw new Error('thread must be a 16-hex-character thread id');
          }
          // Built key by key: a field the body left out must stay absent, since
          // `applySuggestionJudge` reads presence, not value.
          const request: SuggestionJudgeRequest = {};
          if (body.updates !== undefined) request.updates = parseSuggestionStatusUpdates(body.updates);
          if (body.judged !== undefined) request.judged = parseSuggestionJudgements(body.judged);
          if (amnesty !== undefined) request.amnesty = amnesty;
          if (rawThread !== undefined) request.thread = rawThread;
          return applySuggestionJudge(LOG_DIR, request, new Date(), readSource());
        },
        () => 400,
      );
      return;
    }
    const rangeParam = url.searchParams.get('range');
    const statusParam = url.searchParams.get('status');
    const recurrenceParam = url.searchParams.get('recurrence');
    let buckets: number[] | undefined;
    let statuses: SuggestionStatus[] | undefined;
    let recurrences: SuggestionRecurrence[] | undefined;
    try {
      if (rangeParam) buckets = parseBucketRange(rangeParam);
      if (statusParam) {
        statuses = statusParam.split(',').map((s) => {
          const status = s.trim();
          if (!isSuggestionStatus(status)) throw new Error(`invalid status: ${status}`);
          return status;
        });
      }
      if (recurrenceParam) {
        recurrences = recurrenceParam.split(',').map((s) => {
          const recurrence = s.trim();
          if (!isSuggestionRecurrence(recurrence)) throw new Error(`invalid recurrence: ${recurrence}`);
          return recurrence;
        });
      }
    } catch (err) {
      send(res, 400, { error: errorMessage(err) });
      return;
    }
    const detail = url.searchParams.get('detail');
    const filter = {
      buckets,
      statuses,
      recurrences,
      detail: detail === '1' || detail === 'true',
    };
    const status = await buildSuggestionStatus(LOG_DIR, filter, readSource());
    send(res, 200, status);
    shadow('/api/sessions/suggestions/status', status, (source) => buildSuggestionStatus(LOG_DIR, filter, source));
  },
  '/api/sessions/errors': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      const now = new Date();
      const errors = await buildSessionErrors(LOG_DIR, id, now, readSource());
      send(res, 200, errors);
      shadow('/api/sessions/errors', errors, (source) => buildSessionErrors(LOG_DIR, id, now, source));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('invalid session id')) send(res, 400, { error: msg });
      else if (msg.startsWith('session not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  // The chat routes: the only paths that send a request out through the proxy.
  '/api/chat/config': async ({ res }) => {
    send(res, 200, await resolveChatConfig());
  },
  // Which turns are in flight. A read, so it keeps the open CORS the other GETs have;
  // it names running sessions, never their content.
  '/api/chat/running': async ({ res }) => {
    send(res, 200, { running: listRunningChats() });
  },
  // The transcript's own id for a chat session id, or null while the proxy has yet to
  // write it. Answers from the sessions dir rather than the in-memory map, so it survives
  // a restart and outlives the turn. Non-blocking — the caller polls.
  '/api/chat/thread': async ({ res, url }) => {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      send(res, 400, { error: 'missing ?sessionId=' });
      return;
    }
    if (!UUID_RE.test(sessionId)) {
      send(res, 400, { error: 'invalid sessionId: expected a uuid' });
      return;
    }
    send(res, 200, { sessionId, threadId: await resolveThreadId(LOG_DIR, sessionId, 0) });
  },
  // The turn in flight, as it happens: the reply's text as it arrives and a chip per
  // tool, interleaved in the order the turn ran them. The POST still answers with the
  // finished turn, so this is what makes a slow turn legible — never the record of it.
  //
  // A GET, so it is not on the write allowlist — but unlike every other read it carries
  // the chat's own **content**, which is why the manifest declares it `cors: 'origin'`.
  '/api/chat/stream': async ({ req, res, url }) => {
    const cors = { ...chatCors(req.headers.origin), 'access-control-allow-methods': 'GET, OPTIONS' };
    if (!originAllowed(req.headers.origin)) {
      send(res, 403, { error: `origin not allowed: ${req.headers.origin}` }, cors);
      return;
    }
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      send(res, 400, { error: 'missing ?sessionId=' }, cors);
      return;
    }
    if (!UUID_RE.test(sessionId)) {
      send(res, 400, { error: 'invalid sessionId: expected a uuid' }, cors);
      return;
    }
    // A session the server has yet to hear of is not an error: the dashboard names
    // the id and opens this stream in the same tick as the POST that starts it.
    await serveSse(req, res, {
      cors,
      snapshot: () => snapshotChatStream(sessionId),
      subscribe: (push) => subscribeChatStream(sessionId, push),
    });
  },
  '/api/chat/sessions': async ({ req, res }) => {
    await servePost(req, res, (body) =>
      startChat(
        {
          prompt: body.prompt,
          model: body.model,
          maxTokens: body.maxTokens,
          system: body.system,
          mode: body.mode,
          // The dashboard names the session up front so it can stop the first turn.
          sessionId: body.sessionId,
          permissionMode: body.permissionMode,
        },
        LOG_DIR,
      ),
    );
  },
  '/api/chat/sessions/message': async ({ req, res }) => {
    await servePost(req, res, (body) => continueChat({ sessionId: body.sessionId, prompt: body.prompt }, LOG_DIR));
  },
  // Ends the turn, not the session: the in-flight send returns what it had.
  '/api/chat/stop': async ({ req, res }) => {
    await servePost(req, res, async (body) => stopChat({ sessionId: body.sessionId }));
  },
  // Ends the session: "New chat" evicts it rather than leaving it resident forever.
  '/api/chat/sessions/end': async ({ req, res }) => {
    await servePost(req, res, async (body) => endChat({ sessionId: body.sessionId }));
  },
  '/api/skim': async ({ res, date }) => {
    const now = new Date();
    const skim = await buildSkim(LOG_DIR, date, now, ARCHIVE_DIR, readSource());
    send(res, 200, skim);
    shadow('/api/skim', skim, (source) => buildSkim(LOG_DIR, date, now, ARCHIVE_DIR, source));
  },
  '/api/skim/trend': async ({ res, url }) => {
    const now = new Date();
    const days = await parseDays(url.searchParams.get('days'));
    const trend = await buildSkimTrend(LOG_DIR, days, now, readSource());
    send(res, 200, trend);
    shadow('/api/skim/trend', trend, (source) => buildSkimTrend(LOG_DIR, days, now, source));
  },
  '/api/withheld': async ({ res, url }) => {
    const now = new Date();
    const days = await parseDays(url.searchParams.get('days'));
    const withheld = await buildWithheld(LOG_DIR, days, SETTINGS_PATH, now, readSource());
    send(res, 200, withheld);
    shadow('/api/withheld', withheld, (source) => buildWithheld(LOG_DIR, days, SETTINGS_PATH, now, source));
  },
  '/api/pull-requests': async ({ res }) => {
    send(res, 200, await buildPullRequests(LOG_DIR, undefined, undefined, readSource()));
  },
  // The description the list leaves out, for the one pull request a drawer is showing.
  '/api/pull-requests/body': async ({ res, url }) => {
    const number = Number(url.searchParams.get('number'));
    if (!Number.isInteger(number) || number <= 0) {
      send(res, 400, { error: 'missing or invalid ?number=' });
      return;
    }
    send(res, 200, await buildPullRequestBody(LOG_DIR, number));
  },
  // Moving `main`: a force-push of `refs/heads/main` on origin, the local checkout's
  // own catch-up, and the marker that hides a line. They are shared, remote and
  // irreversible in the sense that everyone sees them, so the manifest files them
  // under the origin check rather than the read routes' open CORS — and `slideMain`
  // gates them a second time on the device's `gh` identity.
  '/api/main-history/slide': async ({ req, res }) => {
    await servePost(req, res, (body) => buildMainHistorySlide(body), mainHistoryErrorStatus);
  },
  '/api/main-history/sync-local': async ({ req, res }) => {
    await servePost(req, res, (body) => buildMainHistorySyncLocal(body), mainHistoryErrorStatus);
  },
  '/api/main-history/hide': async ({ req, res }) => {
    await servePost(req, res, (body) => buildMainHistoryHide(body), mainHistoryErrorStatus);
  },
  '/api/hooks-plugins': async ({ res }) => {
    send(res, 200, await buildHooksPlugins());
  },
  '/api/cli-internals': async ({ res }) => {
    send(res, 200, await buildCliInternals());
  },
  '/api/cli-internals/function': async ({ res, url }) => {
    const id = url.searchParams.get('id');
    if (!id) {
      send(res, 400, { error: 'missing ?id=' });
      return;
    }
    try {
      send(res, 200, await buildCliFunction(id));
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.startsWith('cli function not found')) send(res, 404, { error: msg });
      else throw err;
    }
  },
  // The device system prompt: a GET of `~/.claude/CLAUDE.md`, a POST that rewrites it.
  '/api/system-prompt': async ({ req, res }) => {
    // Anything but a GET is the save, which takes the origin-checked write path
    // rather than the open read CORS.
    if (req.method !== 'GET') {
      await servePost(
        req,
        res,
        (body) => buildSystemPromptUpdate(SYSTEM_PROMPT_PATH, body.text, body.expectedModified),
        systemPromptErrorStatus,
      );
      return;
    }
    send(res, 200, await buildSystemPrompt(SYSTEM_PROMPT_PATH));
  },
  '/api/filters': async ({ res }) => {
    send(res, 200, buildFilters());
  },
};

/** Whether a declared route answers under the narrow, origin-checked CORS. */
const narrowCors = (route: ApiRoute | undefined): boolean => route?.cors === 'origin';

const server = http.createServer(async (req, res) => {
  // Before anything else, so a route's duration covers the whole answer.
  const startedAt = performance.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // One lookup answers all three gates below — CORS, methods, and which handler runs.
  const route = apiRoute(url.pathname);

  if (req.method === 'OPTIONS') {
    // The turn stream is a GET, but it answers the same narrow origins the writes do —
    // which is why the manifest states CORS per route rather than deriving it from method.
    res.writeHead(204, narrowCors(route) ? chatCors(req.headers.origin) : CORS);
    res.end();
    return;
  }

  // Everything outside the write allowlist is a read, and the open `*` CORS it answers
  // under is only safe while it stays one. The allowlist gates its own methods inside
  // `servePost`, under the origin-checked CORS instead.
  if (req.method !== 'GET' && !(route && isApiWriteRoute(route))) {
    send(res, 405, { error: `method not allowed: ${req.method}` }, { ...CORS, allow: 'GET, OPTIONS' });
    return;
  }

  if (!route) {
    send(res, 404, { error: `not found: ${url.pathname}` });
    return;
  }

  // Declared routes only, and past every earlier gate: the OPTIONS preflight, the 405 and
  // the 404 all answered above, and none of them is route work.
  res.on('finish', () => observeServedRoute(route.path, res, startedAt));

  try {
    await HANDLERS[route.path]({ req, res, url, date: parseDate(url.searchParams.get('date')) });
  } catch (err) {
    send(res, 500, { error: errorMessage(err) });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`[claude-proxy-server] listening on http://${HOST}:${PORT}`);
  console.log(`[claude-proxy-server] reading audit logs from ${LOG_DIR}`);
  console.log(`[claude-proxy-server] serving ${API_ROUTES.length} routes declared in @claude-proxy/core`);
  // The SQLite view of those logs, kept current by a watcher, and what the
  // routes read. Report which side is serving — a substrate that failed to open
  // falls back silently otherwise.
  const substrate = startSubstrate(LOG_DIR, (err) => console.warn(`[claude-proxy-server] ingest: ${err.message}`));
  console.log(
    substrate
      ? `[claude-proxy-server] ingesting into ${resolveDbPath(LOG_DIR)}` +
          (shadowEnabled() ? ' (shadow comparison on)' : ' (set SHADOW_DB=1 to compare it against the files)')
      : '[claude-proxy-server] sqlite substrate unavailable — serving from the log files only',
  );
  console.log(
    readSource().kind === 'db'
      ? '[claude-proxy-server] serving reads from the substrate (set DB_READS=0 to fall back to the file scan)'
      : `[claude-proxy-server] serving reads from the file scan${dbReadsEnabled() ? '' : ' (DB_READS=0)'}`,
  );
  // Release the watcher and the WAL handle on the way out.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stopSubstrate();
      process.exit(0);
    });
  }
  const chat = await resolveChatConfig();
  console.log(
    `[claude-proxy-server] chat sends ${chat.model} through ${chat.baseUrl} over the ${chat.transport} transport` +
      ` in ${chat.mode} mode` +
      (chat.ready ? '' : ` (disabled: ${chat.readyHint})`),
  );
  // Agent mode can write to the repo, so say so at startup rather than only in docs.
  if (chat.mode === 'agent' && chat.agent) {
    const { cwd, alias, aliasFound, flags, permissionMode } = chat.agent;
    const mirrors = aliasFound
      ? `mirroring the \`${alias}\` alias${flags.disallowedTools.length ? ` (withholding ${flags.disallowedTools.join(', ')})` : ''}`
      : `no \`${alias}\` alias found — running a bare claude`;
    console.log(
      `[claude-proxy-server] agent turns run in ${cwd} with tools (${permissionMode} by default, per-session on the form), ${mirrors}`,
    );
  }
});
