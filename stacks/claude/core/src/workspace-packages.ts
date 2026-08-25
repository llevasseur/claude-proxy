/**
 * The workspace package names, for the commands this code *prints* rather than runs.
 *
 * A `pnpm --filter` argument that names no package is answered with a warning and
 * exit 0, so an invocation printed to an operator is not checked by anything the
 * operator can see: they copy it, it prints a warning they skim past, and nothing
 * happens. That is the same failure as a stale filter in a plist or a workflow, one
 * indirection further out — the string is correct when written and silently wrong
 * after a rename.
 *
 * Naming them here is what makes the next rename a single edit instead of a sweep
 * over every string that happens to embed one. See
 * docs/adrs/0055-the-rename-covers-every-non-import-reference.md.
 */

/** The package behind every headless CLI — `suggestions`, `ideas`, `maintain`, `ingest`. */
export const CLAUDE_SERVER_PACKAGE = '@agent-proxy/claude-server';
