// The listener port comes from `CLAUDE_SERVER_PORT`; the bare `PORT` this package has always
// read stays a fallback scoped to this package alone. See ADR 0050.
//
// Unlike codex's and ox's servers, this one has never validated the value — `Number()` of a bad
// one yields `NaN` and `listen` decides what that means. Adding a range check here would turn a
// launch that works today into one that throws, which is the behaviour change ADR 0050 exists to
// avoid, so the resolution order is scoped from the siblings and the parsing is left as it was.
//
// `PORT` is also what this stack's *proxy* reads, so one exported `PORT` still binds both. That
// collision predates fusion; the scoped name is what makes it overridable.
const DEFAULT_PORT = 8788;

/** The port the server listens on: `CLAUDE_SERVER_PORT`, else the legacy bare `PORT`, else 8788. */
export function resolveServerPort(environment: NodeJS.ProcessEnv = process.env): number {
  return Number(environment.CLAUDE_SERVER_PORT ?? environment.PORT ?? DEFAULT_PORT);
}
