# monorepo-fusion-04 — Sweep every non-import reference to a renamed package

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-04-sweep-non-import-references`
**Status:** active

## Goal

Migrate the 130 places a package name lives outside an import specifier, and prove the
live launchd retention job still does work rather than merely exiting 0.

**This is a judgement ticket, not a find-and-replace.** `--filter server` names one
package today and one of three after fusion, so every site *acquires* a stack it never
needed. Read ADR 0055 before starting.

## Criteria

1. **Clear the gate from ticket 03.** 104 occurrences of `--filter server` and 26 of
   `--filter concepts`. Each acquires an explicit stack.
2. **Update and reload the launchd plists, and prove work was performed.**
   `scripts/com.llevasseur.claude-proxy.maintain.plist` invokes
   `pnpm --filter server maintain --apply`. `launchctl list` confirms it is **loaded on
   this device right now**, last exit 0.
   - Unload, edit, reload, trigger a run.
   - **Assert the maintain job actually did something** — a log line, a byte count, a
     row count. **Exit 0 is not admissible evidence here**: it is precisely the signal
     that cannot distinguish a working job from a no-op one, which is the whole failure
     this ticket exists to prevent.
3. **Make runtime-printed operator commands derive from the package-name constant.**
   `stacks/claude/core/src/ideas.ts` (was `packages/core/src/ideas.ts:1307-1308`) builds
   `pnpm --filter server ideas claim --slug ...` strings and prints them to operators.
   A printed command that lies to an operator is the same failure one indirection out.
4. **Fix `deploy-concepts.yml`'s `--filter` argument.** Ticket 02 repaired its `paths`
   trigger; this repairs `pnpm --filter concepts typecheck` and `test`. Fixing only the
   documented half produces a workflow that fires correctly and then does nothing.
5. **Update `AGENTS.md`.** Six occurrences, including the recorded
   `pnpm --silent --filter server suggestions list -r 9 --json` invocation that exists
   *because* getting it wrong was a repeated, logged failure. This file is not
   documentation here — it is the instruction every future agent in this repository
   reads, so a stale entry re-arms a failure the repository already paid for.
6. **Update the wayfinder maps under `docs/wayfinder/`.**
   `map-sqlite-substrate.md` carries six. ADR 0043 makes the map a control plane, and a
   control plane carrying wrong invocations mis-steers the next agent.

## Out of scope, recorded rather than fixed

`~/Library/LaunchAgents/com.llevasseur.claude-proxy.plist` runs
`/Users/llevasseur/Documents/ghub/claude-proxy/proxy/proxy.mjs` — **a file that does not
exist**; the repository has `proxy/proxy.ts`. Its plist is not tracked in git, so no
ticket reaches it. It is already broken, independently of this campaign. Note it in the
PR body as a device configuration the human owns.

## Done when

The ticket-03 gate is green across the whole tree, `pnpm verify` passes, and the PR body
carries the evidence from criterion 2 — the maintain job's post-reload output showing
work performed, not an exit code.
