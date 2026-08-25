---
type: feature
title: Config inventory
description: Three dashboard pages showing what this device's config and the proxy itself keep out of every Claude Code request.
tags: [dashboard, usage, architecture]
timestamp: 2026-07-24
scope: claude
---

# Config inventory

## Summary

Three [dashboard](admin-dashboard-for-claude-proxy-usage.md) configuration pages:
**Not added** (`/withheld`) for withheld-tool policy, **Proxy filters** (`/filters`)
for the proxy's strip inventory, and **Hooks & Plugins** (`/hooks-plugins`) for
declared hooks/plugins. They read `~/.claude/settings.json` and `~/.zshrc`, using
captured traffic only where it can confirm configuration.

## Motivation

A suppressed tool is visible only by its absence; a declared hook/plugin that never
loads likewise leaves no trace. Two mechanisms MUST remain distinct:

- **The CLI's own schema stripping — device config, not the proxy.** A bare tool name in
  `permissions.deny` (or a bare-name glob like `mcp__*`) makes Claude Code drop that tool's
  schema from the request entirely; a *scoped* rule like `Bash(rm *)` does not — it only blocks
  matching calls at execution time, and the schema still ships. A boolean `disable*` setting
  (`disableWorkflows` → `Workflow`, `disableArtifact` → `Artifact`) strips the same way with
  no `permissions.deny` entry. This happens before the request exists; the proxy only
  witnesses the absence.
- **Proxy stripping for CLI exceptions.** `EndConversation` is deny-exempt, so its schema
  always ships; the harness-injected task-tools nudge has no suppression setting and is
  not reliably stopped by `CLAUDE.md`. These are the only reasons `proxy/proxy.ts`
  edits request bodies; everything else is forwarded untouched.

## Behavior

- **Not added** (`/withheld`) — the device's withheld-tool policy, read from
  `~/.claude/settings.json`: schema-stripping deny rules (**Deny rule** / **Match** exact-vs-glob
  / **Status**), enabled `disable*` settings (**Disable setting** / **Withholds** / **Status**),
  and **Scoped deny rules** listed separately as context because they block calls without saving
  tokens. Each stripping rule is scored against tools observed in recent traffic —
  `GET /api/withheld?days=…`, default **14-day** window — as `absent` (withheld as intended),
  `was-present` (matched only in older requests), or `still-present` (matched in the newest
  tool-bearing request, so it is reaching the model right now). A **Launch aliases** section
  adds the `claude*` shell aliases parsed from the shell rc and their *net effective* posture
  per tool (**on** / **off**), composed from `--disallowedTools`, `--setting-sources`, and
  `--settings`. That grid is computed from settings precedence, **not** traffic-verified: launch
  flags never reach the proxy, and the page says so, along with its blind spot on project/local
  settings.
- **Proxy filters** (`/filters`) — a **static** inventory declared in
  `packages/core/src/filters.ts` as `PROXY_FILTER_INVENTORY` and served verbatim by
  `buildFilters` (which only stamps `generatedAt`); it is the human-readable pairing for the
  proxy's runtime constants `WITHHELD_TOOLS` and `INJECTED_REMINDERS` in `proxy/proxy.ts`.
  Two groups, each a **What** / **Why it needs the proxy** / **How it's stripped** table.
  **Withheld tools**: `EndConversation`, removed from the request's `tools` array before
  forwarding, because the CLI exempts it from `permissions.deny`. **Injected reminders**: the
  **Task-tools nudge** (`task-tools`), whose matching text is removed from message content
  before forwarding, with a block left empty dropped and a message left with no content
  dropped. Those two body edits are the *only* changes the proxy makes to a request: when
  nothing matches, the original bytes are forwarded unchanged, and re-serialization happens
  only if something was actually stripped. Headers are separately normalized for transport —
  hop-by-hop and `accept-encoding` dropped, `content-length` recomputed, auth passed through
  untouched — but the payload is otherwise byte-for-byte.
- **Hooks & Plugins** (`/hooks-plugins`) — a **config view, not runtime**, and the page states
  the limitation in place: hooks are local shell commands Claude Code runs on your machine and
  produce no Anthropic API traffic, so the proxy cannot confirm one ever *fired* — only what
  settings declare. Verify live firing in-session with `/hooks` (and `/plugin` for plugins). It
  shows the `hooks` object flattened to one row per command (**Event** / **Matcher** /
  **Command**, with an optional status message), `enabledPlugins` split into **Plugin** /
  **Marketplace** / **State** (enabled or explicitly disabled), and **Load expectations by
  launch mode** — per `claude*` alias, whether user hooks and plugins are expected to load:
  **native** (the user settings source loads them), **not loaded** (`--setting-sources` dropped
  `user` and nothing re-supplies them), **unverified** (settings injected via a dynamic
  `--settings`, and hooks-via-`--settings` is undocumented), or **expected** (dynamically
  injected and supported, but not confirmed here).

Data flows `~/.claude/settings.json` + `~/.zshrc` → `packages/core` → `server` →
`apps/admin`. `readDeviceSettings` and `readLaunchAliases` feed the pure, I/O-free
`withheldReport`, `computeAliasPosture`, `flattenHooks`, `normalizePlugins`, and
`hookPluginLoadExpectations` helpers. `CLAUDE_SETTINGS` and `CLAUDE_SHELL_RC` override
the default paths. Both readers are non-throwing: missing/malformed files produce an
explicit "couldn't read" state, not an empty table. Endpoints: `GET
/api/withheld?days=…` (live settings + sidecars), `GET /api/hooks-plugins` (live
settings, no traffic), and static `GET /api/filters`.

## Acceptance criteria

- [x] **Not added** lists schema-stripping deny rules, enabled `disable*` settings, and scoped
      deny rules separately, and marks each stripping rule `absent` / `was present` /
      `still present` against the last 14 days of captured requests.
- [x] Scoped `Name(...)` deny rules are classified as non-schema-stripping and shown as context,
      not counted as withheld.
- [x] The launch-alias grid is labelled as computed from settings precedence rather than
      traffic-verified, and aliases with a dynamic `--settings` value are marked
      `indeterminate` instead of guessed.
- [x] **Proxy filters** renders both filter kinds from `PROXY_FILTER_INVENTORY`, covering
      `EndConversation` and the `task-tools` reminder with a reason and a mechanism each.
- [x] The proxy's only request-body edits are those two strips; a request with nothing to strip
      is forwarded byte-for-byte.
- [x] **Hooks & Plugins** flattens `hooks` to one row per command and normalizes
      `enabledPlugins` into name/marketplace/state, tolerating malformed shapes by skipping them.
- [x] The page states that hooks have no API footprint, so it reports declared config and load
      *expectations*, never observed firing.
- [x] All three views are read-only and never write settings: `server/src/settings.ts` and
      `server/src/shell-rc.ts` only `readFile`, there is no write path to
      `~/.claude/settings.json` or the shell rc, and their `/api/withheld`,
      `/api/hooks-plugins`, and `/api/filters` endpoints are GET-only. The server's other
      write routes — chat, suggestion status, the jobs delete (which removes a
      `~/.claude/jobs/<id>` directory), and the system-prompt save (which writes
      `~/.claude/CLAUDE.md`) — never touch `settings.json` or the shell rc.
- [x] `CLAUDE_SETTINGS` and `CLAUDE_SHELL_RC` override the two file paths; a missing or
      unreadable file degrades to an explicit "couldn't read" state instead of an error.
- [x] `packages/core` helpers for withheld rules, launch-alias posture, filters, and
      hooks/plugins are unit-tested; `pnpm typecheck` and `pnpm test` pass.

## Open questions

- Nothing enforces parity between `PROXY_FILTER_INVENTORY` in
  `packages/core/src/filters.ts` and `WITHHELD_TOOLS` / `INJECTED_REMINDERS` in
  `proxy/proxy.ts`. Independent hardcoded tests assert `EndConversation` and
  `task-tools`—`packages/core/test/filters.test.ts` against the inventory and
  `proxy/proxy.test.ts` against runtime constants—but neither imports the other module.
  A third runtime filter would leave the dashboard under-reporting with a green suite;
  one assertion should derive one list from the other.
- `DISABLE_SCHEMA_TOOLS` maps only `disableWorkflows` and `disableArtifact`; any other
  schema-stripping `disable*` key the CLI gains has to be added by hand or **Not added** will
  miss it.
- Launch-alias posture reads only device `user` settings, not the session directory's
  `project` / `local` settings; a tool shown **on** may be **off** in a project that
  re-denies it. Reading project settings remains open.
- `hooks: "unverified"` exists because hooks-via-`--settings` is undocumented; confirming the
  actual behavior once would let that state collapse into `native` or `not-loaded`.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Project memory browser](project-memory-browser.md) — the sibling local `~/.claude` view
