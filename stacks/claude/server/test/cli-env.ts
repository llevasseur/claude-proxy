/**
 * Environment for spawning one of this package's CLIs under test.
 *
 * `NODE_NO_WARNINGS` silences Node's own diagnostics — e.g. the `node:sqlite`
 * experimental warning Node 22 prints on stderr but Node 26 doesn't — so
 * `expect(stderr).toBe('')` only fails on output the CLI itself wrote (ADR 0055).
 * Filtering the warning text instead was rejected: it would tie the assertion to
 * Node's wording rather than the CLI's contract. The variable is inherited down
 * the whole `pnpm` → `tsx` → CLI chain, not just the directly spawned process.
 */
export function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NODE_NO_WARNINGS: '1', ...overrides };
}
