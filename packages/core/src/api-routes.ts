/**
 * Every route the HTTP API answers, declared once.
 *
 * The server used to state each route twice — a `case` in the dispatch switch and a
 * membership test in a hand-written `WRITE_ROUTES` set — and the dashboard stated the
 * same route a third and fourth time, in a client function and in the `fetch` path it
 * built. Four statements of one fact drift independently: a route can be dispatched but
 * unreachable, or reachable but off the write allowlist, and nothing says so.
 *
 * This module is the one statement. `server/src/server.ts` builds its dispatch table
 * from {@link API_ROUTES} — the handler map is keyed by {@link ApiRoutePath}, so a
 * handler for a route that is not declared here does not compile, and a declared route
 * with no handler does not either. `apps/admin/src/api.ts` derives every client function
 * from the same array: the path, the method and the query parameters a call may name all
 * come from here, and the response type is bound to the route by its path.
 *
 * **Response types are types, not runtime entries.** The payloads are the dashboard's
 * `Response` interfaces, which are structural mirrors of what `server/src/api.ts` builds;
 * carrying them as values would mean a schema and a second thing to keep true. The
 * binding is a compile-time map keyed by the paths below, so a route with no response
 * type is a type error at the client helper rather than a silent `unknown`.
 */

/** The methods a route answers. Everything else gets a 405. */
export type ApiMethod = 'GET' | 'POST';

/** One JSON body, or a Server-Sent Events subscription that pushes the same shape. */
export type ApiRouteKind = 'json' | 'sse';

/**
 * Which CORS a route answers under.
 *
 * `open` is the read routes' `*`, which is only safe while they stay reads. `origin` is
 * the narrow, origin-checked headers: every write is on it, because a POST here can start
 * an agent turn that runs commands in this checkout — and so is the chat turn stream,
 * which is a GET but carries the chat's own content.
 */
export type ApiRouteCors = 'open' | 'origin';

/** A route's declaration: what it is called, what it answers, and what it reads. */
export interface ApiRouteDeclaration {
  /** Pathname the server dispatches on and the client fetches. */
  readonly path: string;
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
  { path: '/api/health', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/summary', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  {
    path: '/api/summary/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['date'],
    streamOf: '/api/summary',
  },
  { path: '/api/trends', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/prompt-mix', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/prompt', methods: ['GET'], kind: 'json', cors: 'open', params: ['hash', 'days'] },
  { path: '/api/prompt/section', methods: ['GET'], kind: 'json', cors: 'open', params: ['hash', 'index', 'days'] },
  { path: '/api/tool-schema', methods: ['GET'], kind: 'json', cors: 'open', params: ['name', 'days'] },
  { path: '/api/usage', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/usage/stream', methods: ['GET'], kind: 'sse', cors: 'open', params: [], streamOf: '/api/usage' },
  { path: '/api/tools', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  { path: '/api/context', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/context/thread', methods: ['GET'], kind: 'json', cors: 'open', params: ['thread', 'days'] },
  { path: '/api/context/detail', methods: ['GET'], kind: 'json', cors: 'open', params: ['file'] },
  { path: '/api/context/message', methods: ['GET'], kind: 'json', cors: 'open', params: ['file', 'index'] },
  { path: '/api/context/tool', methods: ['GET'], kind: 'json', cors: 'open', params: ['file', 'index'] },
  { path: '/api/projects', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/projects/memories', methods: ['GET'], kind: 'json', cors: 'open', params: ['project'] },
  { path: '/api/projects/memory', methods: ['GET'], kind: 'json', cors: 'open', params: ['project', 'name'] },
  { path: '/api/jobs', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/jobs/job', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/jobs/file', methods: ['GET'], kind: 'json', cors: 'open', params: ['id', 'file'] },
  // The one destructive route: removes a `~/.claude/jobs/<id>` directory from disk.
  { path: '/api/jobs/delete', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/sessions', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/sessions/stream', methods: ['GET'], kind: 'sse', cors: 'open', params: [], streamOf: '/api/sessions' },
  {
    path: '/api/sessions/session/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['id'],
    streamOf: '/api/sessions/session',
  },
  { path: '/api/sessions/graph', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/sessions/liveness', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/sessions/node-text', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/sessions/graph/nodes', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/sessions/session', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/sessions/breakdown', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/commands', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/commands/stream', methods: ['GET'], kind: 'sse', cors: 'open', params: [], streamOf: '/api/commands' },
  { path: '/api/commands/command', methods: ['GET'], kind: 'json', cors: 'open', params: ['name', 'flags'] },
  {
    path: '/api/commands/command/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['name', 'flags'],
    streamOf: '/api/commands/command',
  },
  { path: '/api/commands/run', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  {
    path: '/api/commands/run/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['id'],
    streamOf: '/api/commands/run',
  },
  { path: '/api/concepts', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/concepts/stream', methods: ['GET'], kind: 'sse', cors: 'open', params: [], streamOf: '/api/concepts' },
  { path: '/api/concepts/concept', methods: ['GET'], kind: 'json', cors: 'open', params: ['ord'] },
  {
    path: '/api/concepts/concept/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['ord'],
    streamOf: '/api/concepts/concept',
  },
  { path: '/api/ideas', methods: ['GET'], kind: 'json', cors: 'open', params: ['status', 'repo', 'area'] },
  {
    path: '/api/ideas/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['status', 'repo', 'area'],
    streamOf: '/api/ideas',
  },
  // The ledger's four writes. They are `origin` rather than `open` because they write a
  // **device-wide** file whose `accepted` rows are what `/improve` acts on.
  { path: '/api/ideas/status', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/area', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/comment', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/claim', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/sessions/suggestions', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/sessions/suggestions/bucket', methods: ['GET'], kind: 'json', cors: 'open', params: ['index'] },
  // A GET list and a POST that writes the flags, on one path. The GET answers under the
  // narrow headers too, which costs it nothing: no browser reads it cross-origin.
  {
    path: '/api/sessions/suggestions/status',
    methods: ['GET', 'POST'],
    kind: 'json',
    cors: 'origin',
    params: ['range', 'status', 'recurrence', 'detail'],
  },
  { path: '/api/sessions/errors', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/chat/config', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/chat/running', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/chat/thread', methods: ['GET'], kind: 'json', cors: 'open', params: ['sessionId'] },
  // A GET, so it is not a write — but it carries the chat's own content, so it answers
  // the dashboard's origins rather than the reads' open `*`.
  { path: '/api/chat/stream', methods: ['GET'], kind: 'sse', cors: 'origin', params: ['sessionId'] },
  { path: '/api/chat/sessions', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/chat/sessions/message', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/chat/stop', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/chat/sessions/end', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/skim', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  { path: '/api/skim/trend', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/withheld', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/pull-requests', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  // Moving `main` is shared, remote and irreversible in the sense that everyone sees it.
  { path: '/api/main-history/slide', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/main-history/sync-local', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/main-history/hide', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/hooks-plugins', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/cli-internals', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/cli-internals/function', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  // A GET of `~/.claude/CLAUDE.md`, and a POST that rewrites it.
  { path: '/api/system-prompt', methods: ['GET', 'POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/filters', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
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

const BY_PATH = new Map<string, ApiRoute>(API_ROUTES.map((route) => [route.path, route]));

/** The declaration for a pathname off the wire, or `undefined` for one nothing declares. */
export function apiRoute(path: string): ApiRoute | undefined {
  return BY_PATH.get(path);
}

/**
 * Whether a route is on the write allowlist — the set the server used to keep by hand as
 * `WRITE_ROUTES`. A write is a POST answered under the origin-checked CORS; the chat turn
 * stream shares those headers without being one, which is why both halves are asked.
 */
export function isApiWriteRoute(route: ApiRoute): boolean {
  return route.cors === 'origin' && (route.methods as readonly ApiMethod[]).includes('POST');
}

/** Whether a declared route answers this method. */
export function apiRouteAnswers(route: ApiRoute, method: string | undefined): boolean {
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
  // Encoded by hand rather than through `URLSearchParams`: this package is pure logic and
  // its typecheck loads neither the DOM nor node's lib, while `encodeURIComponent` is
  // available in every runtime that imports it. It also percent-encodes a space, where
  // the form encoding `URLSearchParams` applies would write a `+`.
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params as Record<string, ApiQueryValue>)) {
    if (value === undefined || value === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length ? `${path}?${pairs.join('&')}` : path;
}
