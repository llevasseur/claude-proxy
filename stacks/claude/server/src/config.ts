// The listener port comes from `CLAUDE_SERVER_PORT`; the bare `PORT` this package has always
// read stays a fallback scoped to this package alone. See ADR 0050.
//
// Unlike codex's and ox's servers, this one has never validated the value — `Number()` of a bad
// one yields `NaN` and `listen` decides. Adding a range check would turn a launch that works
// today into one that throws, so the resolution order is scoped from the siblings but the
// parsing is left alone.
//
// `PORT` is also what this stack's proxy reads; the scoped name is what makes that collision
// overridable.
const DEFAULT_PORT = 8788;

/** The port the server listens on: `CLAUDE_SERVER_PORT`, else the legacy bare `PORT`, else 8788. */
export function resolveServerPort(environment: NodeJS.ProcessEnv = process.env): number {
  return Number(environment.CLAUDE_SERVER_PORT ?? environment.PORT ?? DEFAULT_PORT);
}

/** The proxy's own default, from `stacks/claude/proxy/config.ts`. See ADR 0050. */
const DEFAULT_PROXY_PORT = 8787;

/**
 * Where this server reaches the proxy's loopback control endpoints — today only `/__warm`.
 *
 * `CLAUDE_PROXY_URL` whole, else loopback at `CLAUDE_PROXY_PORT`, else the proxy's default
 * port. **The bare `PORT` the proxy itself falls back to is deliberately not read here.** In
 * this process `PORT` is the *server's* port, so honouring the proxy's fallback would aim the
 * server at itself and the warm page would report the wrong process as unreachable.
 *
 * `127.0.0.1` rather than `localhost`: the control endpoint is loopback-only, and the literal
 * skips a resolver that may answer `::1` first.
 */
export function resolveProxyBaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.CLAUDE_PROXY_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://127.0.0.1:${environment.CLAUDE_PROXY_PORT ?? DEFAULT_PROXY_PORT}`;
}
