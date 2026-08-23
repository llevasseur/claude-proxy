# monorepo-fusion-18 — Stop the server CLI tests failing on Node 22's SQLite warning

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-18-tolerate-node-22-sqlite-warning`
**Cut from and merged into:** `task/monorepo-fusion-17-fix-the-proxy-test-hang` — **not** the
campaign base. Third in a stack: 18 → 17 → 16 → campaign base. Each level is cut from the
branch carrying the interface it consumes, and CI only exists from ticket 16's branch
upward. Merging this turns PR #269 green, which turns PR #268 green, which lands all three
on the campaign base together. **No red PR is merged anywhere in that chain.**
**Status:** active

## Why this ticket exists

Ticket 17 fixed the proxy hang, and fixing it revealed that **`stacks/claude/server`'s
tests had never once run in CI**. pnpm's topological batching never got past the batch the
hanging proxy sat in, so an entire suite was silently skipped while the job merely looked
slow. The first time it ran, three tests failed.

`stacks/claude/server/test/suggestions-cli-json.test.ts` asserts the CLI writes nothing to
stderr, and gets:

```
expected '(node:NNNN) ExperimentalWarning: SQLi…' to be ''
```

**Node 22, which CI runs, emits `ExperimentalWarning: SQLite`. Node 26, which this machine
runs, does not.** The file was last touched on the campaign base itself, so the defect is
pre-existing — it was simply unobservable, twice over: no CI existed until ticket 16, and
once it did, the hang hid this suite behind it.

It is in scope for the same reason ticket 15 and ticket 17 are: the campaign's DONE
criterion is one CI gate that passes, and a gate that cannot go green is not a gate.

## Criteria

1. **Make the assertion tolerant of Node's own warnings without going blind to real stderr
   output.** The test's actual intent is that *the CLI* writes nothing to stderr, not that
   the *process* does. Preferred, in order:
   - Run the CLI with `NODE_NO_WARNINGS=1`, or `--no-warnings`, so the runtime's warning
     never reaches the stream being asserted on. This keeps the assertion exact.
   - Failing that, filter only lines matching Node's `ExperimentalWarning` prefix and
     assert the remainder is empty.
   - **Do not** relax the assertion to "contains no error" or delete it. It exists to catch
     the CLI printing diagnostics into a stream a caller is parsing, which is a real class
     of bug in this repository — ADR 0055's whole subject is output that lies.
2. **Apply it to every test in that file with the same assertion**, not only the three that
   happened to fail.
3. **Check the sibling CLI test files** for the same pattern before finishing, since they
   share the assertion style and have equally never run in CI.
4. **Prove it in CI.** `gh pr checks` green on this ticket's own PR, quoted in the PR body.
   A local run cannot see the warning at all on Node 26, which is exactly why this went
   unnoticed.

## Also in this ticket, if it is cheap

`stacks/claude/server/test/chat-cli.test.ts` has a wall-clock-sensitive assertion
(`expected 602 to be greater than 1000`) that failed once under a loaded local full-suite
run and passed 4/4 in isolation. If the fix is a clear one — waiting on a condition rather
than a duration — take it and say so. If it needs judgement, leave it and report it, and it
becomes its own ticket rather than being bundled in here.

## Constraints

- Own `stacks/claude/server/test/`. Do not touch production code, other stacks, or CI
  configuration.
- **Zero behaviour change.** This is a test-environment defect.

## After this lands

Merge PR #269 (ticket 17), then PR #268 (ticket 16). Both should be green at that point.
Then tickets 16 and 17 complete, and ticket 05 proceeds under a live gate.

## Done when

`gh pr checks` is green on this ticket's PR, the CLI-stderr assertion still fails on
deliberately planted CLI output, and the PR body says which of the three approaches in
criterion 1 was used and why.
