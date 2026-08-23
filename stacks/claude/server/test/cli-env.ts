/**
 * The environment a test spawns one of this package's CLIs with.
 *
 * `NODE_NO_WARNINGS` is the load-bearing entry. The store is read through
 * `node:sqlite`, and Node 22 — the version CI runs — announces that on the child's
 * stderr as `(node:NNNN) ExperimentalWarning: SQLite is an experimental feature…`.
 * Node 26, which these tests were written on, says nothing at all. So a suite that
 * asserts stderr is empty passes on the machine that wrote it and fails in CI, on a
 * line no CLI here ever wrote.
 *
 * Silencing the runtime's own warnings at the source is what keeps the assertion
 * exact rather than merely quiet: `expect(stderr).toBe('')` still fails the moment a
 * CLI prints a diagnostic into a stream a caller is parsing, which is the bug it
 * exists to catch and the whole subject of ADR 0055. Matching the warning text and
 * subtracting it would leave the assertion describing Node's output format instead
 * of the CLI's contract, and would go quiet again the next time Node reworded it.
 *
 * The variable is read by every Node process that inherits it, so it covers the
 * whole `pnpm` → `tsx` → CLI chain rather than only the process spawned directly.
 */
export function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NODE_NO_WARNINGS: '1', ...overrides };
}
