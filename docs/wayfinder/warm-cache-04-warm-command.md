# warm-cache-04 — The /warm command

**Wayfinder:** `warm-cache`
**Branch:** `task/warm-cache-04-warm-command`
**Status:** active

**This ticket's work lands in a different repository**, at
`/Users/llevasseur/Documents/ghub/personal/my-command`. It shares no files with any other
ticket, so it runs in wave 1 and cannot collide.

Because the deliverable is in another repository it needs its own branch, its own pull
request, and its own merge over there. Nothing in this campaign's base branch changes.

## Criteria

1. **The command is one curl.** That is the whole behaviour:

   ```bash
   curl -s -XPOST http://127.0.0.1:${CLAUDE_PROXY_PORT:-8787}/__warm \
     -d "{\"sessionId\":\"$CLAUDE_CODE_SESSION_ID\",\"hours\":8}"
   ```

   `CLAUDE_CODE_SESSION_ID` is present in the Claude Code environment — verified present on
   this device. `CLAUDE_PROXY_PORT` with a `8787` fallback matches
   `stacks/claude/proxy/config.ts` and ADR 0050's scoped names.

   **Send `hours: 8`.** [ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md)
   recommends 2 and records why; the user specified 8 explicitly and that is what ships.
   Do not quietly substitute the recommendation.

2. **Report what the proxy said, and never claim more.** The proxy answers that the
   registration is **pending**, not that anything is being kept warm — it arms only when a
   real request matches, and expires after 2 minutes if none does
   ([ADR 0075](../adrs/0075-registration-stays-pending-until-matched.md)). The command's
   output must say so. A command that reports "session kept warm" on a pending
   registration is the silent failure that ADR exists to prevent.

   Handle a connection refusal plainly: the proxy is not running, say that, and do not
   retry in a loop.

3. **Follow that repository's authoring contract**, which its
   `docs/specs/adding-a-command.md` states and `scripts/check-commands.sh` enforces. Read
   both before writing. It requires all of:

   - **`src/commands/warm.md` is the source of truth.** `commands/warm.md` is **generated**
     by `scripts/build-plugin.sh` — never hand-edit it, and commit the regenerated copy so
     the byte-in-sync check passes.
   - **A Codex-native skill directory**, `skills/warm/SKILL.md`, which must state the
     closing-turn rules in its own words.
   - **A feature doc** for the command.
   - `<!-- include: shared/closing-turn-anchor.md -->` as its own paragraph before the
     first `## ` heading.
   - `<!-- include-block: shared/step-marker.md -->` likewise.
   - A terminal `## Close the run in a text-only turn` section holding
     `<!-- include-block: shared/closing-turn.md -->`.
   - Run `scripts/expand-includes.mjs`, which rewrites those directives in place.
   - A `CHANGELOG.md` entry — that repository has a changelog check.

   The gate fails a command missing any of these, so run it rather than assuming.

4. **It must work when reached as `/task --add warm "keep this session warm while I'm
   away"`.** `/task`'s `--add` resolves the named command from what is installed and lets
   the agent decide when to invoke it. So the command must be correct when invoked **once,
   at the start of a run, with no arguments**, and must need no teardown — registration is
   per-session and expires on its own.

   Keep it cheap. This is a single curl invoked in passing, not a workflow: no repository
   reading, no state, no follow-up polling.

5. **Note the recommendation where a human will see it.** The command's own body should
   carry one short line that registration is best made when actually stepping away rather
   than at session start, citing the campaign's finding. This is guidance in the text, not
   a behaviour change.

## Out of scope

Anything in the `claude-proxy` repository. Building the endpoint this calls — that is
ticket 02; this ticket may be written and merged before the endpoint exists.

## Done when

That repository's own gates pass — at minimum `pnpm check:commands`, `pnpm check`, and
`pnpm test` — and its pull request is merged.
