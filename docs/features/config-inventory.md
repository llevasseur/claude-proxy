---
type: feature
title: Config inventory
description: Three dashboard pages showing what this device's config and the proxy itself keep out of every Claude Code request.
tags: [dashboard, usage, architecture]
timestamp: 2026-07-24
dirty: true
---

# Config inventory

## Summary

Three pages in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md) that answer
**"what is being kept out of my requests, and what does this device declare?"** — **Not added**
(`/withheld`) for the device's withheld-tool policy, **Proxy filters** (`/filters`) for the
proxy's own strip inventory, and **Hooks & Plugins** (`/hooks-plugins`) for the declared hooks
and plugins. Unlike the rest of the dashboard, these read `~/.claude/settings.json` and
`~/.zshrc` rather than analyzing captured traffic: they describe *configuration*, and only
cross-reference traffic where traffic can actually confirm the config.

## Motivation

A tool that never reaches the model costs nothing — and is therefore invisible. There is no
line item for a schema you successfully suppressed, so the only way to know a suppression is
working is to look for the *absence*. The same blind spot applies in reverse to hooks and
plugins: one you declared but that never loads leaves no trace anywhere.

The doc's real job is keeping two different mechanisms straight, because they are easy to
conflate and only one of them is the proxy's:

- **The CLI's own schema stripping — device config, not the proxy.** A bare tool name in
  `permissions.deny` (or a bare-name glob like `mcp__*`) makes Claude Code drop that tool's
  schema from the request entirely; a *scoped* rule like `Bash(rm *)` does not — it only blocks
  matching calls at execution time, and the schema still ships. A boolean `disable*` setting
  (`disableWorkflows` → `Workflow`, `disableArtifact` → `Artifact`) does the same stripping with
  no `permissions.deny` entry to see. All of this happens in the CLI before the request exists;
  the proxy is merely a witness that the tool is gone.
- **The small set the proxy strips itself — because the CLI cannot be configured to.** Some
  tools are *deny-exempt*: `EndConversation` is ignored by `permissions.deny`, so its schema
  ships every turn no matter what settings say. And harness-injected reminder text (the
  task-tools nudge) has no suppression setting at all, and a `CLAUDE.md` instruction does not
  reliably stop it. These two are the entire reason `proxy/proxy.mjs` edits a request body at
  all; everything else it forwards untouched.

## Behavior

- **Not added** (`/withheld`) — the device's withheld-tool policy, read from
  `~/.claude/settings.json`: schema-stripping deny rules (**Deny rule** / **Match** exact-vs-glob
  / **Status**), enabled `disable*` settings (**Disable setting** / **Withholds** / **Status**),
  and **Scoped deny rules** listed separately as context because they block calls without saving
  tokens. Each stripping rule is cross-referenced against tools actually observed in recent
  traffic — `GET /api/withheld?days=…`, defaulting to a **14-day** window — and scored `absent`
  (withheld as intended), `was-present` (matched only in older requests: pre-config history aging
  out), or `still-present` (matched in the newest tool-bearing request, so it is reaching the
  model right now — a stale session, a name typo, or settings precedence). A **Launch aliases**
  section adds the `claude*` shell aliases parsed from the shell rc and their *net effective*
  posture per tool (**on** / **off**), composed from `--disallowedTools`, `--setting-sources`, and
  `--settings`. That grid is computed from settings precedence, **not** traffic-verified: launch
  flags never reach the proxy, and the page says so, along with its blind spot on project/local
  settings.
- **Proxy filters** (`/filters`) — a **static** inventory declared in
  `packages/core/src/filters.ts` as `PROXY_FILTER_INVENTORY` and served verbatim by
  `buildFilters` (which only stamps `generatedAt`); it is the human-readable description paired
  with the proxy's runtime constants `WITHHELD_TOOLS` and `INJECTED_REMINDERS` in
  `proxy/proxy.mjs`. Two groups, each a **What** / **Why it needs the proxy** / **How it's
  stripped** table. **Withheld tools**: `EndConversation`, removed from the request's `tools`
  array before forwarding, because the CLI exempts it from `permissions.deny`. **Injected
  reminders**: the **Task-tools nudge** (`task-tools`), whose matching text is removed from
  message content before forwarding, with a block left empty dropped and a message left with no
  content dropped. Those two body edits are the *only* changes the proxy makes to a request:
  when nothing matches, the original bytes are forwarded unchanged, and re-serialization happens
  only if something was actually stripped. (Headers are separately normalized for transport —
  hop-by-hop and `accept-encoding` dropped, `content-length` recomputed, auth passed through
  untouched — but the payload is otherwise byte-for-byte.)
- **Hooks & Plugins** (`/hooks-plugins`) — a **config view, not runtime**, and the page states
  the limitation in place: hooks are local shell commands Claude Code runs on your machine, they
  produce no Anthropic API traffic, so the proxy cannot confirm one ever *fired* — only what
  settings declare. Verify live firing in-session with `/hooks` (and `/plugin` for plugins). It
  shows the `hooks` object flattened to one row per command (**Event** / **Matcher** / **Command**,
  with an optional status message), `enabledPlugins` split into **Plugin** / **Marketplace** /
  **State** (enabled or explicitly disabled), and **Load expectations by launch mode** — per
  `claude*` alias, whether user hooks and plugins are expected to load: **native** (the user
  settings source loads them), **not loaded** (`--setting-sources` dropped `user` and nothing
  re-supplies them), **unverified** (settings injected via a dynamic `--settings`, and
  hooks-via-`--settings` is undocumented), or **expected** (dynamically injected and supported,
  but not confirmed here).

Data flows `~/.claude/settings.json` + `~/.zshrc` → `packages/core` → `server` → `apps/admin`.
The server reads both files (`readDeviceSettings`, `readLaunchAliases`) and passes their parsed
values into pure `packages/core` helpers — `withheldReport`, `computeAliasPosture`,
`flattenHooks`, `normalizePlugins`, `hookPluginLoadExpectations` — none of which do I/O. The
settings path is `~/.claude/settings.json`, overridable via the `CLAUDE_SETTINGS` env var; the
shell rc is `~/.zshrc`, overridable via `CLAUDE_SHELL_RC`. Both readers are non-throwing: a
missing or malformed file yields an empty, "unreadable" result that each page renders as an
explicit "couldn't read" state rather than an empty table. The endpoints are `GET
/api/withheld?days=…` (computed per request from live settings + sidecars), `GET
/api/hooks-plugins` (computed from live settings, no traffic), and `GET /api/filters` (static).

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
      `server/src/shell-rc.ts` only `readFile`, there is no write path to `~/.claude` or the
      shell rc, and their `/api/withheld`, `/api/hooks-plugins`, and `/api/filters` endpoints
      are GET-only. The server's unrelated chat and suggestion-status POST routes do not
      touch device settings.
- [x] `CLAUDE_SETTINGS` and `CLAUDE_SHELL_RC` override the two file paths; a missing or
      unreadable file degrades to an explicit "couldn't read" state instead of an error.
- [x] `packages/core` helpers for withheld rules, launch-alias posture, filters, and
      hooks/plugins are unit-tested; `pnpm typecheck` and `pnpm test` pass.

## Open questions

- Nothing enforces the "keep the two in sync" pairing between `PROXY_FILTER_INVENTORY` in
  `packages/core/src/filters.ts` and `WITHHELD_TOOLS` / `INJECTED_REMINDERS` in
  `proxy/proxy.mjs`. Both sides *are* tested, but independently and against hardcoded
  expectations — `packages/core/test/filters.test.ts` asserts the inventory contains
  `EndConversation` and `task-tools`; `proxy/proxy.test.mjs` asserts the same two names against
  the runtime constants — and neither test imports the other module, so adding a third withheld
  tool or reminder to the proxy leaves the dashboard silently under-reporting with a green
  suite. Worth a single assertion that derives one list from the other.
- `DISABLE_SCHEMA_TOOLS` maps only `disableWorkflows` and `disableArtifact`; any other
  schema-stripping `disable*` key the CLI gains has to be added by hand or **Not added** will
  miss it.
- The launch-alias posture reads only the device's `user` settings, not the `project` / `local`
  settings of whatever directory a session starts in — so an alias shown **on** for a tool may
  be **off** in a project that re-denies it. Whether to read project settings too is open.
- `hooks: "unverified"` exists because hooks-via-`--settings` is undocumented; confirming the
  actual behavior once would let that state collapse into `native` or `not-loaded`.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard these three pages live in.
- [Project memory browser](project-memory-browser.md) — the sibling view over the other half of
  the local `~/.claude` config surface.
