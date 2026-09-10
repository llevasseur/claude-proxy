/**
 * Every route the HTTP API answers, declared once.
 *
 * `server/src/server.ts` builds its dispatch table from {@link API_ROUTES}, keyed by
 * {@link ApiRoutePath}: a handler for an undeclared route does not compile, and a
 * declared route with no handler does not either. `apps/admin/src/api.ts` derives every
 * client function from the same array — path, method and the query parameters a call may
 * name — with the response type bound to the route by its path.
 *
 * **Response types are types, not runtime entries.** The binding is a compile-time map
 * keyed by the paths below, so a route with no response type is a type error at the
 * client helper rather than a silent `unknown`.
 *
 * ## Every route says whose data it reads
 *
 * Each declaration carries a {@link ApiRouteProvider}, and that field is what makes
 * "provider-scoped" a property of the manifest rather than a convention handlers are
 * trusted to keep. `docs/adrs/0046-narrowly-scoped-local-writes.md` gives each store one
 * controller and `docs/adrs/0062-three-servers-and-one-moved-port.md` refuses one process
 * reading three stores, so **this server answers only for its own provider**: the
 * dispatcher rejects a route scoped to another one instead of serving it, and a request
 * for Anthropic therefore cannot reach the OpenAI or Ox Alpha store by any path.
 *
 * The field is not a filter the dashboard applies — it is the declaration a filter would
 * have had to duplicate. A page that reads several providers asks **several origins** for
 * the same path (`admin/src/provider-fanout.ts`); it never asks one server for another
 * server's provider.
 */

import type { ProviderId } from './adapter-seam.js';

/** The methods a route answers. Everything else gets a 405. */
export type ApiMethod = 'GET' | 'POST';

/** One JSON body, or a Server-Sent Events subscription that pushes the same shape. */
export type ApiRouteKind = 'json' | 'sse';

/**
 * Which CORS a route answers under: `open` is the read routes' `*`, `origin` the narrow
 * origin-checked headers. Every write is `origin`, and so is the chat turn stream.
 */
export type ApiRouteCors = 'open' | 'origin';

/**
 * Whose store a route reads: one provider, or none at all.
 *
 * `agnostic` is not "every provider" — it is **no provider corpus**. The device and
 * repository ledgers (jobs, notes, ideas, concepts, pull requests, the health probe) are
 * not a proxy's observations, so they are the same answer whichever provider the picker
 * is on, and fanning them out over three origins would ask three servers one question
 * with one answer. A route naming a {@link ProviderId} reads that provider's corpus and
 * only that one.
 *
 * The distinction matters at exactly one place — the dispatcher's scope gate — and it is
 * the reason that gate can be total: every route is either this server's provider's, or
 * nobody's.
 */
export type ApiRouteProvider = ProviderId | 'agnostic';

/** A route's declaration: what it is called, what it answers, and what it reads. */
export interface ApiRouteDeclaration {
  /** Pathname the server dispatches on and the client fetches. */
  readonly path: string;
  /**
   * Whose store this route reads. A server serves a route only when this is its own
   * provider or `agnostic`; anything else is a misdirected request, not a 404.
   */
  readonly provider: ApiRouteProvider;
  /** Methods it answers. A route answering both lists the read first. */
  readonly methods: readonly ApiMethod[];
  readonly kind: ApiRouteKind;
  readonly cors: ApiRouteCors;
  /** Query parameters it reads. A client may name these and nothing else. */
  readonly params: readonly string[];
  /** For an `sse` route, the JSON route whose payload it pushes. */
  readonly streamOf?: string;
}

export const API_ROUTES = [
  { path: '/api/health', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/summary', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  {
    path: '/api/summary/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['date'],
    streamOf: '/api/summary',
  },
  // `models` is a comma-separated list; absent means every model the days hold.
  {
    path: '/api/trends',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['days', 'models'],
  },
  { path: '/api/prompt-mix', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  {
    path: '/api/prompt',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['hash', 'days'],
  },
  {
    path: '/api/prompt/section',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['hash', 'index', 'days'],
  },
  {
    path: '/api/tool-schema',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['name', 'days'],
  },
  { path: '/api/usage', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/usage/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: [],
    streamOf: '/api/usage',
  },
  { path: '/api/tools', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  // The table's order and slice ride the query string: the window is summarized whole
  // and shipped one page of thread rows at a time, so a month is not a 30 MB answer.
  {
    path: '/api/context',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['days', 'sort', 'dir', 'offset', 'limit', 'q'],
  },
  // One reporting day of that window, on its own — a caller composes a window from these.
  // `?date=` omitted means the day in progress.
  { path: '/api/context/day', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  // The one day of that window that can still change, pushed as captures land. **No
  // `date`**: a closed day is answered `immutable` and cannot move, so leaving the
  // parameter off makes a closed day unsayable here rather than refused at subscribe time.
  // The open day is re-resolved from the clock per rebuild, so a subscription held past
  // midnight follows the rollover.
  {
    path: '/api/context/day/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: [],
    streamOf: '/api/context/day',
  },
  {
    path: '/api/context/thread',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['thread', 'days'],
  },
  // One thread's requests, pushed as its captures land. **`thread` is required and `days`
  // mirrors the JSON route**: the frame replaces that route's answer in the reader's
  // cache, so it has to be the answer for the same thread over the same window. Whether a
  // thread is worth subscribing to is not asked here — `/api/sessions/liveness` says that
  // — and a caller that subscribes to a finished one gets a stream that never pushes.
  {
    path: '/api/context/thread/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['thread', 'days'],
    streamOf: '/api/context/thread',
  },
  {
    path: '/api/context/detail',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['file'],
  },
  {
    path: '/api/context/message',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['file', 'index'],
  },
  {
    path: '/api/context/tool',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['file', 'index'],
  },
  { path: '/api/projects', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/projects/memories',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['project'],
  },
  {
    path: '/api/projects/memory',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['project', 'name'],
  },
  { path: '/api/jobs', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/jobs/job', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  {
    path: '/api/jobs/file',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['id', 'file'],
  },
  // The one destructive route: removes a `~/.claude/jobs/<id>` directory from disk.
  { path: '/api/jobs/delete', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/sessions', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/sessions/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: [],
    streamOf: '/api/sessions',
  },
  {
    path: '/api/sessions/session/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['id'],
    streamOf: '/api/sessions/session',
  },
  { path: '/api/sessions/graph', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/sessions/liveness', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/sessions/node-text',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['id'],
  },
  {
    path: '/api/sessions/graph/nodes',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['id'],
  },
  {
    path: '/api/sessions/session',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['id'],
  },
  {
    path: '/api/sessions/breakdown',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['id'],
  },
  { path: '/api/commands', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/commands/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: [],
    streamOf: '/api/commands',
  },
  {
    path: '/api/commands/command',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['name', 'flags'],
  },
  {
    path: '/api/commands/command/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['name', 'flags'],
    streamOf: '/api/commands/command',
  },
  { path: '/api/commands/run', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  {
    path: '/api/commands/run/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['id'],
    streamOf: '/api/commands/run',
  },
  { path: '/api/concepts', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/concepts/stream',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: [],
    streamOf: '/api/concepts',
  },
  {
    path: '/api/concepts/concept',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['ord'],
  },
  {
    path: '/api/concepts/concept/stream',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['ord'],
    streamOf: '/api/concepts/concept',
  },
  // Searched by prose rather than by the listing's columns. No stream — a search is a
  // question a reader asked, not a view that follows the store.
  { path: '/api/concepts/search', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: ['q'] },
  {
    path: '/api/ideas',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['status', 'repo', 'area'],
  },
  {
    path: '/api/ideas/stream',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['status', 'repo', 'area'],
    streamOf: '/api/ideas',
  },
  // The ledger's four writes. `origin` rather than `open`: the file is device-wide, and
  // its `accepted` rows are what `/improve` acts on.
  { path: '/api/ideas/status', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/area', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/comment', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/claim', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  // The rate table an operator edits, and its two writes.
  //
  // `anthropic` rather than `agnostic`: these rows are *this* proxy's prices, and each
  // stack declares its own fallback, so a rate defensible here says nothing about another
  // provider's corpus. There is no `valid_from` parameter and no as-of date anywhere in
  // these three, because there is nothing to date — one current rate per model prices the
  // whole corpus (ADR 0044), resolved on every read (ADR 0065).
  { path: '/api/pricing', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  // Add or correct one model's four rates. `origin` like every write: an edit here
  // reprices every historical total the dashboard shows.
  { path: '/api/pricing/model', provider: 'anthropic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  {
    path: '/api/pricing/model/delete',
    provider: 'anthropic',
    methods: ['POST'],
    kind: 'json',
    cors: 'origin',
    params: [],
  },
  {
    path: '/api/notes',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['cursor', 'limit', 'archived'],
  },
  {
    path: '/api/notes/stream',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['cursor', 'limit', 'archived'],
    streamOf: '/api/notes',
  },
  {
    path: '/api/notes/search',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['q', 'cursor', 'limit'],
  },
  { path: '/api/notes/note', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/notes/create', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes/update', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes/archive', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes/restore', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  {
    path: '/api/sessions/suggestions',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: [],
  },
  {
    path: '/api/sessions/suggestions/bucket',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['index'],
  },
  // A GET list and a POST that writes the flags, on one path — so the GET answers under
  // the narrow headers too.
  {
    path: '/api/sessions/suggestions/status',
    provider: 'anthropic',
    methods: ['GET', 'POST'],
    kind: 'json',
    cors: 'origin',
    params: ['range', 'status', 'recurrence', 'detail'],
  },
  { path: '/api/sessions/errors', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/chat/config', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/chat/running', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/chat/thread',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['sessionId'],
  },
  // A GET, so not a write — but it carries the chat's own content, so it answers the
  // dashboard's origins rather than the open `*`.
  {
    path: '/api/chat/stream',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'sse',
    cors: 'origin',
    params: ['sessionId'],
  },
  { path: '/api/chat/sessions', provider: 'anthropic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  {
    path: '/api/chat/sessions/message',
    provider: 'anthropic',
    methods: ['POST'],
    kind: 'json',
    cors: 'origin',
    params: [],
  },
  { path: '/api/chat/stop', provider: 'anthropic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  {
    path: '/api/chat/sessions/end',
    provider: 'anthropic',
    methods: ['POST'],
    kind: 'json',
    cors: 'origin',
    params: [],
  },
  { path: '/api/skim', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  { path: '/api/skim/trend', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/withheld', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/pull-requests', provider: 'agnostic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  // One pull request's body — what the drawer asks for when it opens.
  {
    path: '/api/pull-requests/body',
    provider: 'agnostic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['number'],
  },
  // Moving `main` is shared, remote and irreversible in the sense that everyone sees it.
  {
    path: '/api/main-history/slide',
    provider: 'agnostic',
    methods: ['POST'],
    kind: 'json',
    cors: 'origin',
    params: [],
  },
  {
    path: '/api/main-history/sync-local',
    provider: 'agnostic',
    methods: ['POST'],
    kind: 'json',
    cors: 'origin',
    params: [],
  },
  { path: '/api/main-history/hide', provider: 'agnostic', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/hooks-plugins', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/cli-internals', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  {
    path: '/api/cli-internals/function',
    provider: 'anthropic',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['id'],
  },
  // A GET of `~/.claude/CLAUDE.md`, and a POST that rewrites it.
  {
    path: '/api/system-prompt',
    provider: 'anthropic',
    methods: ['GET', 'POST'],
    kind: 'json',
    cors: 'origin',
    params: [],
  },
  { path: '/api/filters', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  // What share of this provider's spend rests on a fallback rate rather than a published
  // one — ADR 0044's stamp, resolved against the rate table on every call and stored
  // nowhere (ADR 0065). Provider-scoped because it reads one corpus and one proxy's
  // declared fallback; a share under one provider says nothing about another.
  { path: '/api/pricing/mix', provider: 'anthropic', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
] as const satisfies readonly ApiRouteDeclaration[];

/** One entry of the manifest, with its literal path, methods and parameters preserved. */
export type ApiRoute = (typeof API_ROUTES)[number];

/** Every declared pathname. The server's handler map and the client's helpers key on it. */
export type ApiRoutePath = ApiRoute['path'];

/** The declaration for one path. */
export type ApiRouteFor<P extends ApiRoutePath> = Extract<ApiRoute, { path: P }>;

/** The query parameters a call to `P` may name — `never` for a route that reads none. */
export type ApiRouteParam<P extends ApiRoutePath> = ApiRouteFor<P>['params'][number];

/** Paths answering a JSON GET: everything the dashboard reads with `fetch`. */
export type ApiJsonGetPath = Extract<
  ApiRoute,
  { kind: 'json'; methods: readonly ['GET'] | readonly ['GET', 'POST'] }
>['path'];

/** Paths answering a POST: the write surface, and nothing else. */
export type ApiWritePath = Extract<ApiRoute, { methods: readonly ['POST'] | readonly ['GET', 'POST'] }>['path'];

/** Paths served as Server-Sent Events. */
export type ApiStreamPath = Extract<ApiRoute, { kind: 'sse' }>['path'];

/** Paths that read one provider's corpus — the fan-out surface. */
export type ApiProviderScopedPath = Exclude<ApiRoute, { provider: 'agnostic' }>['path'];

/** Paths that read no provider corpus, and are therefore the same answer under any provider. */
export type ApiAgnosticPath = Extract<ApiRoute, { provider: 'agnostic' }>['path'];

/**
 * The fan-out surface: a JSON GET that reads one provider's corpus.
 *
 * An intersection of two literal unions, so it is exactly their overlap. This is the
 * domain of the dashboard's three-origin client — asking three servers for an agnostic
 * route would be three copies of one answer, and asking them for a write would be three
 * writes.
 */
export type ApiProviderJsonGetPath = ApiJsonGetPath & ApiProviderScopedPath;

/**
 * Whether a server serving `served` may answer this route.
 *
 * The whole scope rule, in one predicate, so the dispatcher and the tests that police it
 * cannot drift apart. `agnostic` is answered by every server because it reads no
 * provider's corpus; anything else is answered only by the provider that owns it.
 */
export function apiRouteServedBy(route: ApiRouteDeclaration, served: ProviderId): boolean {
  return route.provider === 'agnostic' || route.provider === served;
}

/** Every declared route a server for `served` answers. */
export function apiRoutesFor(served: ProviderId): readonly ApiRoute[] {
  return API_ROUTES.filter((route) => apiRouteServedBy(route, served));
}

const BY_PATH = new Map<string, ApiRoute>(API_ROUTES.map((route) => [route.path, route]));

/** The declaration for a pathname off the wire, or `undefined` for one nothing declares. */
export function apiRoute(path: string): ApiRoute | undefined {
  return BY_PATH.get(path);
}

/**
 * Whether a route is on the write allowlist: a POST answered under the origin-checked
 * CORS. Both halves are asked because the chat turn stream shares those headers as a GET.
 */
export function isApiWriteRoute(route: ApiRoute): boolean {
  // SAFETY: each route's `methods` is an `as const` tuple, so `.includes('POST')` is a
  // type error on a route that never lists POST. Every literal in every tuple is drawn
  // from `ApiMethod`, so widening to it asks the question this predicate exists to ask.
  return route.cors === 'origin' && (route.methods as readonly ApiMethod[]).includes('POST');
}

/** Whether a declared route answers this method. */
export function apiRouteAnswers(route: ApiRoute, method: string | undefined): boolean {
  // SAFETY: the argument is a method string off the wire, so it cannot be narrowed to
  // the route's literal tuple before the comparison — finding out whether it belongs is
  // the point. Reading the tuple as `readonly string[]` loses only those literals.
  return (route.methods as readonly string[]).includes(method ?? '');
}

/** A query value as a caller supplies it; `undefined` and `''` are omitted from the URL. */
export type ApiQueryValue = string | number | boolean | undefined;

/**
 * Build the URL for a declared route. The parameter names are the ones the manifest
 * declares for that path, so a query the server never reads is a type error here.
 */
export function apiRouteUrl<P extends ApiRoutePath>(
  path: P,
  params: Partial<Record<ApiRouteParam<P>, ApiQueryValue>> = {},
): string {
  // Hand-encoded rather than via `URLSearchParams`: this package's typecheck loads
  // neither the DOM nor node's lib. It also writes `%20` for a space, not `+`.
  const pairs: string[] = [];
  // SAFETY: `Object.entries` over a mapped type is typed too loosely to keep the key
  // literals; only the value type matters here and it is unchanged. Every value is still
  // `ApiQueryValue`, and the `undefined` a `Partial` admits is dropped on the next line.
  for (const [key, value] of Object.entries(params as Record<string, ApiQueryValue>)) {
    if (value === undefined || value === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length ? `${path}?${pairs.join('&')}` : path;
}
