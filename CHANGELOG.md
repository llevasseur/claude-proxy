# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

This project has not cut a release yet, so everything below sits under
`[Unreleased]`, grouped by the date its pull request merged (newest first).

## [Unreleased]

### Added

- **A device-wide browser for `~/.claude/jobs`** — a new **Jobs** station lists every background job directory on the machine, whichever project it ran in: state, working directory, file count, size and last activity, newest first, with **Jobs / Running / Husks / On disk** tiles above it. A state word is badged by *tone* rather than matched exactly, so a vocabulary Claude Code extends degrades to `unknown` instead of being forced into a known bucket, and a directory with no readable `state.json` is listed as a **husk** rather than hidden — its job is gone, its scratch space is still on your disk. A job's own page shows what the state file says (the prompt it was given, agent and model, any PR it opened, what it had in flight at the last write) and presents the directory as a **folder tree**: directories before files, collapsible, opening on `state.json`, with `node_modules` and friends listed but never descended into and symlinks listed but never followed. Selecting any file opens it with a **Pretty / Raw** toggle — pretty re-indents and colours JSON, renders `timeline.jsonl` as badged state changes, strips terminal escapes and collapses carriage-return progress redraws out of a build log, numbers and colours source, and inlines a screenshot; raw is the bytes on disk, for the moment you suspect the pretty view of hiding something. Reading is confined to the job: the id and every path segment are validated, then the resolved path is `realpath`'d and re-checked against the job root, so a symlink an agent left in its own `tmp/` cannot become a way to read the filesystem; text is capped at 512 KB and a file whose bytes contain a NUL is reported as binary rather than shown as mojibake. Backed by `GET /api/jobs`, `GET /api/jobs/job?id=` and `GET /api/jobs/file?id=&file=` (`CLAUDE_JOBS` overrides the directory), with the shaping and the viewer transforms pure and unit-tested in `packages/core`.
- **From a session into the live graph** — the sessions list gains a `graph →` link per row and a session's own page one beside its live indicator, both landing on `/sessions/graph?session=<threadId>`. The graph reads that search param instead of always opening on the newest session: it canvases the linked session's family, and centers the branch when what was linked is a subagent. Picking in the rail writes the param back, so the canvas survives a reload and the URL is shareable. The graph inspector's existing "Open transcript →" now has a way back.

### Changed

- **The sessions rail files things away, and the chat pane is just a chat** — the rail splits into **Active** and **Resolved**, each with its own scroller and a divider you can drag (or arrow) to give one of them more room; the split persists in `localStorage`. Hovering a card reveals a single control: a checkmark files it into Resolved, an arrow pulls it back and floats it to the top of Active. Resolved is stored as a mark plus a timestamp rather than a flag, so a session that takes another turn returns to Active on its own — the mark only holds while the transcript has been quiet since it was made. Search and a `+` for a new chat moved to the foot of the rail, inline with each other. On the chat side the page header is gone: the permission picker now sits in the prompt input's own toolbar the way a frontier chat client carries its controls, the posture disclaimers went with the header, "Chat vs Agent" is no longer a choice (a dashboard session is always an agent — the tools are the point), "Start an agent session" is the centered, larger empty state, and the model / base URL / transport line, the sessions directory and the live indicator became a footnote under the input.

- **Sessions is a chat client** — the page is now a full-height two-pane layout: a scrolling rail of transcripts on the left and the session you start from here filling the pane beside it. The rail (`SessionsSidenav`) sorts newest-first, filters by name / id / prompt / model, and renders 30 rows at a time, paging the next 30 from an `IntersectionObserver` sentinel as you scroll — `/api/sessions` returns the whole list in one payload, so the windowing is over what is *rendered*, which is what a machine with hundreds of transcripts pays for on first paint. The sortable table it replaces is gone; each row carries the name, a two-line prompt preview, a short age (`fmtAgeShort`) and model / tool / error chips. `ChatConversation` became a proper chat panel — avatar-and-bubble turns with the reader's own mirrored right, a transcript that follows itself down as turns land, a typing indicator for the prompt in flight, and a composer pinned below it — so the session page's live-chat card gets the same treatment. A short conversation anchors to the composer instead of the top of the pane, and under 900px the rail stacks above the chat.

- **A session's name wears the signal color, its id doesn't** — the title and the thread id swapped colors in the sessions list, so the primary label is the one that stands out and the mono id under it reads as plain text. The id keeps its link and hover underline, and a session with no name still shows its id in signal — `.session-id` only applies when a name sits above it.

### Fixed

- **The day rolls over at local midnight, not 20:00** — every day-bucketed Overview and Trend value is now bucketed in Eastern (`America/New_York`, so EST or EDT as the date dictates) instead of on the sidecar timestamp's raw UTC prefix. An evening's work used to jump to "tomorrow" as soon as UTC crossed midnight, so the Overview both counted the *previous* evening's requests and hid the current one's — on a sample day that was 676 requests wrongly included and 265 wrongly missing. Because the proxy names files in UTC, one reporting day now straddles the filenames `D` and `D+1`: the filename filter selects a superset and each sidecar's own timestamp narrows it exactly, and `readArchivedDay` merges the two UTC archive folders a reporting day spans. Busiest-hour is computed and labelled in the same zone (`17:00 EDT`, not `17:00 UTC`), and the Overview date line and the "By day" tables name the zone they're in. The Skim trend buckets in the same zone, so its days line up with the window that selects them. Digests already finalized into the archive keep the UTC buckets they were written with; raw archived sidecars take precedence over them, so this only shows on days whose sidecars have been pruned.
- **An unsent chat draft survives navigating away** — what you typed into the Sessions page composer but never sent is no longer discarded the moment you click through to a session, the graph, or anywhere else. The draft moved out of `ChatConversation`'s component state (which unmounts with the page) and into `ChatSessionProvider`, which already sits above the router so the turn log, pending prompt and Stop button outlive the page they were started on — the input now travels with them. It still clears where clearing is the point: `send` empties it on submit rather than on success, since the prompt is already on screen as a turn, and "New chat" clears it along with the session it belonged to.

- **Sessions are named, not numbered** — a transcript now headlines what it is instead of its thread id, which is what 92 of 100 local transcripts showed. Only a session Claude Code titled itself carried a name, and it only titles interactive chats: a dashboard-started run is headless (`claude --print`) and a subagent shares its parent's session id, so neither is ever titled. `deriveSessionName` condenses the opening prompt into a short sentence-case name for those, `sessionName`/`sessionDisplayName` set one fallback order (CLI title → derived name → prompt → id) that the listing, the graph, the detail page and a suggestion's sources all read, and the id stays as the mono sublink. Two title-linking bugs went with it: a title landing on the *first* thread whose opening prompt matched left a second thread with the same prompt permanently nameless (it now goes to the most recently active **untitled** match, and never displaces a title already written), and titles were only ever matched against in-memory threads, so a proxy restart dropped them — an unclaimed title now waits in a `.pending-titles.json` sidecar and a title arriving for a thread that exists only on disk is written to it directly.

## 07-26-2026

### Added

- **Suggestion status flags in the dashboard** — the Advice pages now show the flags the API and CLI already wrote. A bucket's drill-down badges each suggestion `Done`/`Skipped`, dims the ones acted on, and carries a `Pending / Done / Skipped` control that records the flag through `POST /api/sessions/suggestions/status` and re-reads the list rather than patching the row; `Pending` is the undo. A "hide resolved" toggle folds away what is finished, and the Advice bucket list marks resolved suggestions and counts how many are still open per window. Breakdown-derived suggestions stay unflagged — the status store is keyed per bucket suggestion and has no row for them. (#67)
- **Interruptions in the live session graph** — a run that was cut off now shows the severed step with a coral ring and torn edge, and lays the resumed steps out in an inset dashed "side trail" labelled with why it stopped; the toolbar counts interruptions, the legend gains a swatch, and the inspector gains "Cut off" / "Resumed after". Both sources are covered: Claude Code's Esc (`splitInterruption` strips the `[Request interrupted by user]` marker the CLI prepends) and the dashboard's Stop button (`recordInterruption` appends `- interrupted: <why>` to the thread's transcript, since the child is killed before anything reaches the wire). (#63)
- **Session suggestions carry a status flag** — every suggestion is `pending` until marked `done` or `skipped` (with an optional note), keyed by `(bucket, suggestion id)` so the flag survives the recomputation that happens on every load, and stored in `<logDir>/suggestion-status.json` beside the transcripts it describes. A lean `GET /api/sessions/suggestions/status?range=2-9&status=pending` lists one row per suggestion so an agent can find outstanding work across a range of buckets without pulling each drill-down, `POST` to the same path records flags, and `pnpm --filter server suggestions list|mark` does both from the command line with no server running. `&detail=1` (`-d`) adds each suggestion's detail, evidence and sources when the caller is about to act on them. (#66)
- **Start a session lands on that session's page** — sending the first dashboard chat now navigates to `/sessions/$id` addressed by the chat session id (a uuid; thread ids are 16 hex chars), where the page polls a new read-only `GET /api/chat/thread?sessionId=` until the transcript exists and then replaces the URL with the thread id. The chat itself moved above the router (`ChatSessionProvider`) so the turn log, Stop button and pending prompt survive the navigation, and renders as a section between the stats and the Transcript card — the prompt in flight shown as a turn immediately, the reply when it lands, and an input to carry on. The running-turn Stop bar hides when this tab owns the turn. (#65)
- **Untruncated graph steps** — live session graph nodes now derive their text from the captured request body's `messages[]` (`deriveSessionNodes`) and merge it over the transcript stream, so prompts and command lines no longer arrive cut off at the transcript's 160/60-char gists; the node inspector became an expandable drawer. (#60)

### Changed

- **Dashboard chats default to `bypassPermissions`** — the start-a-session form and `DEFAULT_PERMISSION_MODE` now open on the mode a dashboard `/task` needs to finish its git writes; narrower modes are the opt-in for turns that shouldn't act. (#57)

### Fixed

- **Chat turns time out on silence, not elapsed time** — a turn is now bounded by an idle timeout re-armed on every stdout/stderr chunk plus a separate absolute ceiling, instead of one 300s wall-clock cap that SIGTERMed healthy 27-request agent loops mid-tool-call. (#56)
- **Rail collapse toggle placement** — the sidenav collapse button now occupies the `admin` brand pill's slot in the rail head instead of overflowing it. (#58)
- **Clicking the graph dismisses the details drawer** — a stationary press on empty canvas now clears the node selection on pointer-up (a 4px slop threshold keeps real pans from counting as clicks), so clicking anywhere off the nodes closes the drawer the way a backdrop would; clicking another node still switches to it, and Esc already closed it outside fullscreen. (#64)
- **Scroll pans the Live Graph** — a plain wheel or two-finger trackpad scroll now pans both axes (shift-wheel pans horizontally) instead of zooming on every wheel event; ⌘-scroll zooms about the cursor at the old 1.12 notch step and trackpad pinch zooms continuously, with the +/− buttons carrying a tooltip that names the modifiers. (#62)

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
