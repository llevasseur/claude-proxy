# monorepo-fusion-17 — Fix the proxy test suite hanging in CI

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-17-fix-the-proxy-test-hang`
**Status:** active

## Why this ticket exists

Ticket 16 landed this repository's first PR gate, and **the first execution of that gate
caught a hang**. `pnpm test` passes locally in 27 seconds and does not terminate in CI:
`stacks/claude/proxy` runs to `ok 77`, never prints a TAP summary, and never exits. That
is an **open handle, not a failing assertion** — the tests all pass and the process
refuses to die.

PR #268 is open and unmerged because of it. The ticket-16 runner correctly declined to
merge a red PR and declined to fix this, since the fix lives under `stacks/` and outside
its lane.

**Why this is in scope**, given ADR 0050's rule that pre-existing awkwardness is out of
scope to fix: the hang is pre-existing in the code but was **never observable** before,
because no CI gate existed to run the suite in a non-interactive environment. And the
campaign's own DONE criterion is one CI gate that passes. **A gate that can never go green
is not a gate**, so the same reasoning that created ticket 15 applies here.

**Do not land PR #268 red to get past this.** The first thing a new gate does must not be
to get overridden — that establishes, for every remaining ticket in this campaign and the
two after it, that red CI is negotiable.

## Criteria

1. **Find the open handle.** `stacks/claude/proxy` uses node's built-in runner
   (`node --test`), not vitest. The usual causes, in rough order of likelihood: an HTTP
   server or socket left listening, an interval or timeout never cleared, a file watcher,
   or a child process not awaited. `node --test` will not exit while any of them is
   referenced.
   - Reproduce it non-interactively rather than trusting a local run — the entire defect
     is that a local run succeeds. Run the suite with stdio not attached to a TTY, or
     under the same command CI uses.
   - `why-is-node-running`, or `process.getActiveResourcesInfo()` in an
     `after()` hook, will name the handle rather than leaving you to guess.
2. **Fix the leak at its source.** Close the server, clear the timer, unref the handle —
   whatever the actual cause is.
   - **Do not fix it by forcing exit.** A `process.exit()` in a teardown hook, or
     `--test-force-exit`, makes the symptom disappear and keeps the leak, which then
     silently truncates any future test that needs the process to drain. If the honest fix
     genuinely requires forcing exit, say so explicitly in the PR body with the handle
     named, rather than slipping it in.
3. **Prove it in CI, not locally.** This ticket's own PR must show `gh pr checks` green.
   A local `pnpm test` passing is precisely the evidence that misled everyone here and is
   **not admissible** as this ticket's proof.
4. **Confirm the failure set is otherwise unchanged**, so the fix does not mask something
   else.

## Constraints

- **Zero behaviour change to the proxy itself.** This is a test-lifecycle defect. If the
  leak turns out to be in production code rather than test code, fix the smallest thing
  that closes the handle and say so plainly — do not refactor around it.
- Own `stacks/claude/proxy/` test files, and production code there only if the handle
  genuinely originates in it.

## After this lands

**Merge PR #268.** Ticket 16's work is complete and both its proofs hold; only its
"Done when" green-CI condition was blocked by this hang. Once CI is green, #268 merges and
ticket 16 completes, and ticket 05 proceeds under a live gate.

## Done when

`gh pr checks` on this ticket's PR is green, the suite exits on its own in CI without a
forced exit, and the PR body names the handle that was leaking.
