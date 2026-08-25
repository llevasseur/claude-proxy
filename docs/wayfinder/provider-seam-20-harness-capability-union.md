# provider-seam-20 — Widen `HarnessCapability` so the device-config gates say what they mean

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-20-harness-capability-union`
**Status:** active

Depends on tickets 01 and 11, both merged.

Ticket 01 defined `HarnessCapability` in `stacks/claude/core/src/harness-adapter.ts` as a
**closed three-member union** — `session-transcripts`, `system-prompt-capture`,
`skim-cache` — and its doc comment says why it is closed: a surface gating on a free-form
string fails open on a typo, which is the failure the gate exists to prevent. That reason
still holds and this ticket does not touch it. The union stays closed; it gets wider.

Ticket 11 then audited 29 capabilities against that union and found it too narrow. **Four
device-config capabilities had to declare `session-transcripts` as "the nearest
established member" rather than a precise gate**, because ticket 11 could not edit
`harness-adapter.ts` — that file was ticket 01's and already merged. Ticket 11 recorded
the stand-in honestly in two places rather than letting it pass silently: the doc comment
of `stacks/claude/core/src/capabilities.ts` and
[`docs/features/capability-gating.md`](../features/capability-gating.md), both of which
say outright that widening the union belongs to whichever ticket owns
`harness-adapter.ts`.

**No remaining ticket owns that file.** Without this one the imprecision ships, the notes
pointing at a future ticket point at nothing, and a later reader takes four gates that
name session transcripts to mean session transcripts — reading a documented placeholder
as an intentional design. That is the whole reason this ticket exists.

## Criteria

1. **Identify the four capabilities gated on the stand-in.** Ticket 11 names them in both
   records: `hooks-and-plugins`, `slash-commands`, `cli-internals`, and `project-memory`.
   Confirm that against the module rather than trusting this list, and confirm no fifth
   has since joined them.

2. **Widen `HarnessCapability` with the members those four actually need.** What they
   share is not "this harness writes readable transcripts" but "this harness's device and
   project configuration is state this repository can read" — decide from the four
   surfaces themselves how many members that is, and name each for the state it gates on.
   Keep the union closed, and keep each member's doc comment saying what supporting it
   means, the way ticket 01's three do.

3. **Repoint the four.** Each of the four gates on the member it actually needs, and the
   harness adapters that support it declare it. `claude-code` supports the new members;
   the other harnesses answer false, which is what the gate is for.

4. **Remove the stand-in notes once they are no longer true** — from the doc comment in
   `stacks/claude/core/src/capabilities.ts` and from `docs/features/capability-gating.md`.
   Both currently explain the stand-in and defer the widening to a future ticket. A note
   describing a workaround that no longer exists is worse than no note: it sends the next
   reader looking for a placeholder that is gone. Update the classification tables in both
   places so the harness-gate column reads the same as the code.

5. **Keep the two axes independent, per
   [ADR 0040](../adrs/0040-three-providers-and-three-harnesses.md).** No new harness member
   may encode a provider, and no capability may infer one gate from the other. Today's
   three pairs are one-to-one and that must not leak into a member name or a declaration.

6. **Delete nothing.** All 29 capabilities stay present and classified, and ticket 11's
   test that a claude session still sees all 29 keeps passing unchanged. If that test
   needs editing to stay green, the change is wrong: it is the pin that proves this
   campaign gates rather than removes.

7. `my-command-tools verify` green.
