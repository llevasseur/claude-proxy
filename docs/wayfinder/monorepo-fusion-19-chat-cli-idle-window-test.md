# monorepo-fusion-19 — Fix the chat-cli idle-window test's dependence on cold-start timing

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-19-chat-cli-idle-window-test`
**Status:** done · 2026-08-24

## Why this ticket exists

`stacks/claude/server/test/chat-cli.test.ts`, in the case *"lets a still-producing run
outlive the idle window many times over"*, asserts
`expect(Date.now() - started).toBeGreaterThan(1_000)` with `idleTimeoutMs: 600` and
`maxTurnMs: 1_500`. It failed once under a loaded full-suite run with
`expected 602 to be greater than 1000`, and passed 4/4 in isolation.

Ticket 18 investigated and established what the number means, which is what makes this a
ticket rather than a flake to re-run:

> **602 ms means the run genuinely *ended* at 602 ms.** The chatty child's first line had
> not arrived within the 600 ms idle window, so the **idle clock fired instead of the
> ceiling the test is about.**

So the test is not merely slow — under load it silently stops testing the thing it names.
A green run and a red run differ in *which timer fired*, and only the red one says so.

Ticket 18 left it deliberately: the idle timer is armed inside `runCliTurn` at spawn,
which is production code and outside that ticket's lane, and raising the two magnitudes
past node's cold-start cost is a judgement call rather than a mechanical fix.

## Criteria

1. **Make the test wait on the condition it is about, not on a duration.** The case exists
   to prove a run that keeps producing output survives past the idle window. The honest
   assertion is that **output was still arriving** when the ceiling stopped it — not that
   wall-clock elapsed exceeded a number.
2. **If the idle clock can fire before the child's first line, that is worth stating
   plainly** — either as a fixed test (wait for first output before starting the clock the
   assertion measures) or, if the behaviour is wrong in production rather than in the test,
   as a finding reported rather than silently patched. Say which it is.
   - `runCliTurn` arming the idle timer at spawn, before any output can exist, means a
     cold start counts against the idle window. Decide whether that is intended. If it is,
     the test must account for it; if it is not, this ticket reports it and a follow-up
     owns the production change, because **zero behaviour change still holds**.
3. **Do not simply raise the timeouts** until the flake stops reproducing. That restores
   green without restoring the assertion's meaning, and the next slower machine takes it
   away again. If raising them genuinely is the right answer, justify it against measured
   cold-start cost rather than by picking a number that passed.
4. **Run the full suite under load**, not in isolation — isolation is what makes this pass
   and is the reason it survived until now.

## Constraints

- Own `stacks/claude/server/test/chat-cli.test.ts`. Production code only if criterion 2
  concludes the defect is there, and then report it rather than expanding scope.
- **Zero behaviour change** to the server.

## Done when

The test asserts on output rather than elapsed time (or its timing is justified by
measurement), it passes under a loaded full-suite run, and the PR body says whether the
cold-start-counts-against-idle behaviour is intended.
