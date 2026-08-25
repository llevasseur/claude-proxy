# monorepo-fusion-21 — Fix the codex proxy test's flakiness under parallel load

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-21-codex-proxy-test-flake`
**Status:** done · 2026-08-23

## Why this ticket exists

Promoted from residual risk 16, now measured twice by two different tickets:

- **Ticket 06:** `stacks/codex/proxy`'s `proxy.test.ts:596` failed **once in five** local
  full-suite runs — `null !== 0`, a spawned-CLI exit code — while passing 3/3 in isolation
  before and after, and 24/24 on CI.
- **Ticket 20:** the same suite failed **2 of 9** local whole-repo runs
  (`node --test test/*.test.ts`).

Three of ten local full-suite runs across two independent tickets is not noise. It is the
same class as ticket 20's ox flake, which turned out to be a real shared-state defect
rather than timing — and ticket 20's fix removed a poll loop instead of adding one.

**Ticket 20 is the template.** It named the shared state before touching anything, fixed
the mechanism rather than the symptom, and reported both rates. Read its plan and its PR
before starting here.

## Criteria

1. **Reproduce it under load, and get a rate.** It appears only in whole-repo runs, never
   in isolation, so run the full suite repeatedly rather than the file. Record failures over
   a denominator large enough to compare against — the prior evidence is 3 failures in 10.
2. **Name the shared state.** `null !== 0` on a spawned CLI's exit code means the process
   had not exited when the assertion ran, or its exit was observed on the wrong event. Look
   for an unawaited `spawn`, a `close`-versus-`exit` confusion, or a timeout racing the
   child — not for a number to raise.
3. **Fix the mechanism, not the symptom.** No retry, no sleep, no raised timeout. Ticket 20
   *removed* a 50-attempt poll loop whose comment named its race; that is the standard here.
4. **Prove it by rate, with both numbers in the PR body**, plus a regression test that fails
   deterministically against the unfixed code where that is possible.
5. **If this machine cannot reproduce it, say so plainly and move the measurement to CI**
   rather than running a loop to a meaningless zero. Ticket 20 hit exactly that wall —
   macOS FSEvents against Linux inotify — stopped the inconclusive loop, and said why. That
   is the honest outcome, not a failure.

## Constraints

- Own `stacks/codex/proxy/test/`, and codex's proxy source only if criterion 2 concludes the
  shared state lives there.
- **Zero behaviour change** to codex's proxy. If the honest fix would change behaviour, stop
  and report.
- codex is **not** under a warn tier — its anti-slop severities were restated to the root's
  in ticket 05 — so every file this ticket touches must pass at `error`, as the ratchet
  already requires everywhere.

## Done when

The failure rate under whole-repo load is measurably zero over a meaningful denominator,
both rates are in the PR body, no retry or sleep was added, and `gh pr checks` is green.
