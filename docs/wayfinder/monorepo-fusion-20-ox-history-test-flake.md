# monorepo-fusion-20 — Fix the ox history test's flakiness under CI load

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-20-ox-history-test-flake`
**Status:** active

## Why this ticket exists

Ticket 08 exposed it and paid for it twice. `stacks/ox-alpha/server/test/history.test.ts`
**failed 2 of 5 CI runs, with a different test failing each time** —
`advances the SSE data-version…`, then `paginates newest-first…` — and passes locally.
Both ticket 07 and ticket 08 needed a CI re-run with no code change to go green.

That pattern — different test each run, green on retry, clean locally — is a shared
fixture or a shared clock, not two independent bugs. It will keep costing a re-run on
every PR that touches ox, and a gate that goes green on a second attempt teaches everyone
to press the button again rather than read the failure.

Ticket 08 deliberately did not fix it: the fix means editing ox source, and its own lane
forbade that.

## Criteria

1. **Reproduce it before changing anything.** Run the file in a loop under load —
   concurrently with the rest of the suite, not in isolation, since isolation is exactly
   where it passes. Establish a failure rate you can compare against afterwards; "it
   passed once" is what a flaky test always says.
2. **Find the shared state.** Two different tests failing on different runs points at
   something they share: a database file or connection reused across cases, an SSE stream
   left open, a timestamp or version counter that assumes monotonic wall-clock, or
   ordering that depends on insert timing rather than an explicit sort. Name it before
   fixing it.
3. **Fix the sharing, not the symptom.** Do not add a retry, do not add a sleep, and do
   not raise a timeout to make it pass. Each of those keeps the flake and hides it — and
   this campaign has already seen what a gate that reports the wrong thing costs.
4. **Prove the fix by rate, not by one green run.** Same loop as criterion 1, same load,
   and report both rates in the PR body. A single green run is not evidence of anything
   here.

## Constraints

- Own `stacks/ox-alpha/server/test/`, and ox's server source only if criterion 2 concludes
  the shared state genuinely lives there — in which case fix the smallest thing that
  removes the sharing and say so plainly.
- **Zero behaviour change** to ox's server. If the honest fix would change behaviour, stop
  and report it rather than taking it.
- ox source is under the `warn` tier from ticket 08, but **every file this ticket touches
  must pass at `error` before it is done** — that is the ratchet, and this is the first
  ticket to owe it.

## Done when

The failure rate under load is measurably zero across a run count large enough to mean
something, both rates are in the PR body, no retry or sleep was added, and `gh pr checks`
is green on the first attempt.
