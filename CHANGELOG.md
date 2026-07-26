# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

This project has not cut a release yet, so everything below sits under
`[Unreleased]`, grouped by the date its pull request merged (newest first).

## [Unreleased]

## 07-26-2026

### Added

- **Untruncated graph steps** — live session graph nodes now derive their text from the captured request body's `messages[]` (`deriveSessionNodes`) and merge it over the transcript stream, so prompts and command lines no longer arrive cut off at the transcript's 160/60-char gists; the node inspector became an expandable drawer. (#60)

### Changed

- **Dashboard chats default to `bypassPermissions`** — the start-a-session form and `DEFAULT_PERMISSION_MODE` now open on the mode a dashboard `/task` needs to finish its git writes; narrower modes are the opt-in for turns that shouldn't act. (#57)

### Fixed

- **Chat turns time out on silence, not elapsed time** — a turn is now bounded by an idle timeout re-armed on every stdout/stderr chunk plus a separate absolute ceiling, instead of one 300s wall-clock cap that SIGTERMed healthy 27-request agent loops mid-tool-call. (#56)
- **Rail collapse toggle placement** — the sidenav collapse button now occupies the `admin` brand pill's slot in the rail head instead of overflowing it. (#58)
- **Scroll pans the Live Graph** — a plain wheel or two-finger trackpad scroll now pans both axes (shift-wheel pans horizontally) instead of zooming on every wheel event; ⌘-scroll zooms about the cursor at the old 1.12 notch step and trackpad pinch zooms continuously, with the +/− buttons carrying a tooltip that names the modifiers.

## 07-25-2026

### Added

- **Dashboard chat sessions** — start a Claude Code session from the dashboard in `chat` (read-only) or `agent` mode, with `GET /api/chat/running` listing turns in flight and a `RunningChatBar` on the session page that can stop a turn started in another tab. (#48)
- **Peak context per session** — session detail gained a Peak context tile that drills into the Request breakdown of the largest request that session sent, backed by a pure `sessionContextPeak` and `GET /api/sessions/breakdown`. (#53)
- **Collapsible side rail with station icons** — the rail collapses to a 64px icon-only strip (lucide icons on all 12 stations), persisting through `localStorage` and gated above 861px. (#49)
- **`scripts/proxy-store-env.sh`** — resolves `CLAUDE_PROXY_STORE` from the checkout itself rather than a hand-maintained path, with `--setup` / `--check` / `--hookup` modes and a zellij preflight that surfaces an unconfigured shell. (#47)

### Changed

- **Overview station icon** — swapped from lucide `LayoutDashboard` to `Monitor`. (#54)
- **Docs bundle reconciled with the code** — repaired five unparseable wayfinder tickets (missing `type`, unquoted `wayfinder:prototype` label), fixed the README that prescribed the broken YAML, regenerated all six `index.md` listings, and added feature docs for already-shipped work. (#46)

### Fixed

- **Trends span the full window** — `buildTrends` now reads archived raw sidecars; the previous path looked for a `digest.json` that is never written anywhere, so every archived day resolved to `null` and 30-day views silently collapsed to the ~2 days still in `logs/`. (#52)
- **Session graph side panels keep their own wheel** — scrolling the expanded rail or node inspector no longer zooms the graph, with `overscroll-behavior: contain` and `touch-action: pan-y` on both. (#45)
- **Stable dashboard page width** — standard pages fill their workspace at every size and cap at 1200px, so headers stop growing after data loads; the graph keeps its full-bleed layout. (#51)
- **1-based message numbering** — the Request breakdown `#` column, drill-down heading, breadcrumb, Position tile, and pager all read from 1; route params and the API stay 0-based. (#55)

## 07-24-2026

### Added

- **Live session streaming over SSE** — the Sessions list and per-session transcript update in real time via `GET /api/sessions/stream` and `/api/sessions/session/stream`, backed by a generic `serveSse()` helper (snapshot + debounced `fs.watch` updates, heartbeat, teardown) and a `useLiveQuery()` hook. No new dependencies. (#39)
- **Per-metric trend charts on Overview** — every stat card carries a sparkline of that metric's real per-day history, a 7/14/30-day window selector, a hover popover of daily values with linked chart-node/row highlighting, and a per-metric drill-down. (#40)
- **Session titles and subtitles** — transcripts now capture the thread's reminder-stripped first user message (subtitle) and the CLI's own auto-generated chat title, which the proxy recovers from the separate titling request and links back to the thread. (#41)

### Changed

- **Live session graph redesign** — the graph is full-bleed with a floating toolbar, shows one session at a time as a viewport-adaptive boustrophedon fold, and gained a collapsible left session rail. (#37)
- **Graph fits the space the rail leaves free** — a `freeArea()` helper measures the rail live (272px expanded / 38px collapsed / 78% on narrow viewports) so fitting and focus-centering stop hiding the session behind the overlaid list. (#43)

### Fixed

- **Rail collapse actually collapses** — the old 18px peek lip plus `:hover` reopen was a no-op for a cursor that hadn't moved; the rail now narrows to a 38px strip with an explicit reopen affordance that is keyboard- and touch-reachable. (#42)
- **Subagent branches on the graph** — `spawnAgentType()` / `isAgentSpawn()` / `linkAgentSessions()` reconstruct the parent/subagent tree, which nothing on the wire names, by matching each spawn against the session family's transcripts in start-time order. (#42)

## 07-23-2026

### Added

- **Passive per-agent session transcripts** — the proxy maintains append-only `logs/sessions/<threadId>.md` handoff artifacts distilled per turn into `task` / `decided` / `tool` / `error` / `done` lines, keyed by conversation-root thread and filtered so one-shots never get a file. Records a tool name plus one key arg only — never schemas, payloads, or the system prompt. (#33)
- **Sessions browser** — a Sessions page listing every transcript newest-first with model and task/tool/error counts, plus a detail page with stat tiles and a Pretty/Raw viewer, over new `GET /api/sessions` endpoints and a pure `parseSessionTranscript()`. (#34)
- **Per-session Errors page** — errored tool results render as coral, left-accented transcript rows and get a dedicated `/sessions/$id/errors` route linking each error back to its task and probable tool call. (#36)
- **Hooks & Plugins inventory** — a config-inventory page over `~/.claude/settings.json` `hooks` and `enabledPlugins` with per-launch-alias load expectations (`native` / `not-loaded` / `unverified` / `expected`). Explicitly not a live tracker: hooks never reach the API. (#28)
- **Project memories viewer** — Projects list, project detail, and memory detail routes with a Pretty/Raw viewer and sortable File/Size/Modified columns, over new server-side project discovery. (#30)
- **Injected-reminder stripping + Proxy filters page** — the proxy removes harness-injected reminders (starting with the "task tools haven't been used" nudge) that no setting can suppress, and `PROXY_FILTER_INVENTORY` renders the canonical filter list in the dashboard. (#35)
- **Message pagination** — a Previous/Next pager on the message details page walks adjacent messages of the same request, disabled at each end. (#31)
- **Breadcrumb trails** — a reusable `Breadcrumbs` component replaces the single back link on five drill-down routes. (#32)
- **Favicon and per-page titles** — a ClaudeProxy brand-mark favicon and route-declared `staticData.title` synced into `document.title`. (#38)

### Changed

- **`EndConversation` stripped from forwarded requests** — Claude Code exempts a few protected tools from `permissions.deny`, so their schemas keep shipping every turn; the proxy now removes `WITHHELD_TOOLS` at the single chokepoint, re-serializing the body only when something is actually removed. (#29)

## 07-22-2026

### Added

- **All context requests, sortable** — `/context` lists every request in the window (newest-first by default, sortable on When/Model/Real input/System/Tools/Size) instead of a fixed 10-largest list; `summarizeContext` returns an `entries` array alongside its aggregates. (#22)
- **Net effective alias posture** — `computeAliasPosture` derives each `claude*` alias's real withheld tool set from settings precedence, parsing `--setting-sources` and inline `--settings` overrides, so aliases stop reporting "withholds nothing". (#27)

### Changed

- **Local-timezone timestamps** — analytics timestamps render in the viewer's timezone via `Intl` (no date library); UTC-bucketed aggregates keep their UTC labels rather than being mislabeled. (#24)
- **Trends plots the whole window** — the line chart shows every day in the 7/14/30-day range instead of paging three days at a time, and the default window dropped from 14 to 7 days. (#25)
- **Trends reads the durable digest archive** — `buildTrends` merges live `logs/` digests with one small archived `digest.json` per past day, so charts fill the window instead of collapsing to the ~2 days still on disk. (#26)

### Fixed

- **Stats/card spacing** — a `.grid + .card` rule restores the missing gap where a stats row butted against the following card on the request-breakdown page. (#23)

## 07-21-2026

### Added

- **Context size analytics** — a page answering what the average context is, when it peaked, and why, measured on `tokens.realInput`, with `summarizeContext` / `analyzeRequestBody` helpers, `GET /api/context` and `/api/context/detail`, and a traversal-guarded `file` handle. (#18)
- **Message drill-down** — `/context/$file/message/$index` renders any message's role, size, and full content from the parsed body, so it resolves even when the raw-JSON view was truncated. (#19)
- **Pretty/Raw toggles and a tool drill-down** — message and per-tool detail subpages gained word-wrapped Pretty/Raw views, and the breakdown leads with messages. (#21)
- **Launch aliases section on Not added** — a pure `parseLaunchAliases(rc)` extracts `--disallowedTools` from `claude*` shell functions and aliases, surfacing tools stripped per launch. Declarative by nature: the flag never reaches the proxy, so it can't be traffic-verified. (#17)

### Fixed

- **Readable full-message text** — `.rawjson` uses `var(--text)` instead of near-black `var(--ink)` on a dark background. (#20)
- **Contained breakdown tables** — `overflow-wrap: anywhere` on cells and `nowrap` on headers/numerics keep long `mcp__…` tool names from blowing out the layout. (#21)

## 07-20-2026

### Added

- **Non-streaming usage capture** — `decodeResponse` falls back to a single JSON message's top-level `usage`, so non-streaming responses (e.g. sonnet-5 safety-classifier calls) log real token counts instead of 0. (#14)
- **Per-session identity in sidecars** — each audit record carries a `session` block (session id, app, user agent, account/session/device from `metadata.user_id`), so spend attributes per session and subagent instead of being guessed by timestamp. (#14)
- **`disable*` settings on Not added** — boolean schema-stripping settings such as `disableWorkflows` and `disableArtifact` are now resolved to tools and verified against recent traffic alongside `permissions.deny` rules. (#16)
- **Device setup docs** — README covers running the proxy on this device (`PORT=8036`, `pnpm zellij`) and the zshrc alias routing the `claude` CLI through it. (#15)

### Fixed

- **Model attribution** — `model` falls back to the response model when the request body omits it, clearing "unknown" model rows. (#14)

## 07-19-2026

### Added

- **Skim cache dashboard** — aggregate hit rate, saved tokens and spend, and recurring request shapes from audit sidecars, over daily and trend skim APIs, with each shape's user request text recovered from its sibling request log. (#11)
- **Wayfinder project skill** — `.claude/skills/wayfinder/SKILL.md` adapted for this repo (verify via `pnpm typecheck && pnpm test && pnpm build`, docs under `docs/specs/` and `docs/adrs/`). (#13)
- **Cacheability research and guardrails** — analysis of 1,787 captured request bodies putting the byte-exact repeat floor at ~1.1% (~0.6% for the streamed `/v1/messages` subset the skim caches) and collapsing ~99% of traffic into ~63 recurring shapes, plus a decision doc fixing the cache's default-off posture, kill switch, never-cache list, and staleness bound. (#10, #9)

### Fixed

- **Zellij services stop with the terminal** — `pnpm zellij` runs through a terminal-scoped launcher with a unique session name and quits the server on forced closure, so watchers and Vite processes stop being orphaned while unrelated sessions survive. (#12)

## 07-18-2026

### Added

- **Opt-in skim response cache** — `proxy/skim.mjs` short-circuits byte-exact repeat streamed `/v1/messages` requests by replaying the stored SSE reply with zero upstream calls. Off unless `SKIM_CACHE` is set; keyed on `sha256(rawBody)` with a `SKIM_TTL_MS` TTL, and reported in a `skim` block on each sidecar. Distinct from Anthropic's prefix cache — this caches model output, so hits work across sessions. (#7)
- **Tokens-per-request chart** — a multi-series line chart of real input, output, and cache tokens per request on Trends, via a reusable themed `SeriesLineChart` (recharts). (#5)

### Changed

- **Side-nav layout and telemetry-console redesign** — the horizontal topbar became a left side rail styled as "the line" the proxy taps, with a signal palette (teal/amber/coral), a mono/sans split that encodes data vs. prose, and a live health pulse; folds to a top bar under 860px. (#6)

## 07-16-2026

### Added

- **Monorepo and admin dashboard** — the single-file proxy repo became a pnpm workspace: `proxy/` (moved intact, still zero-dependency), `packages/core` (typed sidecars, digests, cost estimation, pluggable advice), `server/` (read-only Node API over the logs), and a TanStack admin dashboard for usage, trends, and advice. Verified against 2,381 real sidecars. (#1)
- **"Not added" page** — reports and verifies device-wide withheld tools against captured traffic, after the proxy's own audit found 13 tool schemas riding along ~1,300 times each in 14 days. (#4)

### Changed

- **Proxy default port** — dev workflow and docs moved the proxy to `PORT=8036`, documenting that proxy and server both read a bare `PORT` and must be set per process. (#3)

## 07-15-2026

### Added

- **Zellij dev layout** — `.zellij/claude-proxy.kdl` opens proxy, server, and dashboard panes in one window via `pnpm zellij`. (#2)
