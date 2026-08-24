// The listener port comes from `CLAUDE_PROXY_PORT`; the bare `PORT` this package has always
// read stays a fallback scoped to this package alone. See ADR 0050.
//
// Unlike codex's and ox's proxies, this one has never validated the value — `Number()` of a
// bad one yields `NaN` and `listen` decides. Adding a range check would turn a launch that
// works today into one that throws, so the resolution order is scoped from the siblings but
// the parsing is left alone.
//
// `PORT` is also what this stack's server reads; the scoped name is what makes that
// collision overridable.
const DEFAULT_PORT = 8787;

/** The port the proxy listens on: `CLAUDE_PROXY_PORT`, else the legacy bare `PORT`, else 8787. */
export function resolveProxyPort(environment: NodeJS.ProcessEnv = process.env): number {
  return Number(environment.CLAUDE_PROXY_PORT ?? environment.PORT ?? DEFAULT_PORT);
}
