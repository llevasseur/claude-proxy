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
 */

/** The methods a route answers. Everything else gets a 405. */
export type ApiMethod = 'GET' | 'POST';

/** One JSON body, or a Server-Sent Events subscription that pushes the same shape. */
export type ApiRouteKind = 'json' | 'sse';

/**
 * Which CORS a route answers under: `open` is the read routes' `*`, `origin` the narrow
 * origin-checked headers. Every write is `origin`, and so is the chat turn stream.
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
  // `models` is a comma-separated list; absent means every model the days hold.
  { path: '/api/trends', methods: ['GET'], kind: 'json', cors: 'open', params: ['days', 'models'] },
  { path: '/api/prompt-mix', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/prompt', methods: ['GET'], kind: 'json', cors: 'open', params: ['hash', 'days'] },
  { path: '/api/prompt/section', methods: ['GET'], kind: 'json', cors: 'open', params: ['hash', 'index', 'days'] },
  { path: '/api/tool-schema', methods: ['GET'], kind: 'json', cors: 'open', params: ['name', 'days'] },
  { path: '/api/usage', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/usage/stream', methods: ['GET'], kind: 'sse', cors: 'open', params: [], streamOf: '/api/usage' },
  { path: '/api/tools', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  // The table's order and slice ride the query string: the window is summarized whole
  // and shipped one page of thread rows at a time, so a month is not a 30 MB answer.
  {
    path: '/api/context',
    methods: ['GET'],
    kind: 'json',
    cors: 'open',
    params: ['days', 'sort', 'dir', 'offset', 'limit', 'q'],
  },
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
  // Searched by prose rather than by the listing's columns. No stream — a search is a
  // question a reader asked, not a view that follows the store.
  { path: '/api/concepts/search', methods: ['GET'], kind: 'json', cors: 'open', params: ['q'] },
  { path: '/api/ideas', methods: ['GET'], kind: 'json', cors: 'open', params: ['status', 'repo', 'area'] },
  {
    path: '/api/ideas/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['status', 'repo', 'area'],
    streamOf: '/api/ideas',
  },
  // The ledger's four writes. `origin` rather than `open`: the file is device-wide, and
  // its `accepted` rows are what `/improve` acts on.
  { path: '/api/ideas/status', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/area', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/comment', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/ideas/claim', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes', methods: ['GET'], kind: 'json', cors: 'open', params: ['cursor', 'limit', 'archived'] },
  {
    path: '/api/notes/stream',
    methods: ['GET'],
    kind: 'sse',
    cors: 'open',
    params: ['cursor', 'limit', 'archived'],
    streamOf: '/api/notes',
  },
  { path: '/api/notes/search', methods: ['GET'], kind: 'json', cors: 'open', params: ['q', 'cursor', 'limit'] },
  { path: '/api/notes/note', methods: ['GET'], kind: 'json', cors: 'open', params: ['id'] },
  { path: '/api/notes/create', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes/update', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes/archive', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/notes/restore', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/sessions/suggestions', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  { path: '/api/sessions/suggestions/bucket', methods: ['GET'], kind: 'json', cors: 'open', params: ['index'] },
  // A GET list and a POST that writes the flags, on one path — so the GET answers under
  // the narrow headers too.
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
  // A GET, so not a write — but it carries the chat's own content, so it answers the
  // dashboard's origins rather than the open `*`.
  { path: '/api/chat/stream', methods: ['GET'], kind: 'sse', cors: 'origin', params: ['sessionId'] },
  { path: '/api/chat/sessions', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/chat/sessions/message', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/chat/stop', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/chat/sessions/end', methods: ['POST'], kind: 'json', cors: 'origin', params: [] },
  { path: '/api/skim', methods: ['GET'], kind: 'json', cors: 'open', params: ['date'] },
  { path: '/api/skim/trend', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/withheld', methods: ['GET'], kind: 'json', cors: 'open', params: ['days'] },
  { path: '/api/pull-requests', methods: ['GET'], kind: 'json', cors: 'open', params: [] },
  // One pull request's body — what the drawer asks for when it opens.
  { path: '/api/pull-requests/body', methods: ['GET'], kind: 'json', cors: 'open', params: ['number'] },
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
 * Whether a route is on the write allowlist: a POST answered under the origin-checked
 * CORS. Both halves are asked because the chat turn stream shares those headers as a GET.
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
  // Hand-encoded rather than via `URLSearchParams`: this package's typecheck loads
  // neither the DOM nor node's lib. It also writes `%20` for a space, not `+`.
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params as Record<string, ApiQueryValue>)) {
    if (value === undefined || value === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length ? `${path}?${pairs.join('&')}` : path;
}
