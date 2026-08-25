---
type: feature
title: Capability gating on the two adapters
description: Every claude capability classified as Anthropic-wire-specific, Claude-Code-specific, both, or neither, gated on two axes that cannot see each other.
tags: [providers, harness, adapters, gating, campaign]
timestamp: 2026-08-25
scope: claude
---

# Capability gating on the two adapters

## Gating is not deletion

Every capability named on this page still exists, still has its code, and still renders
for the sessions it applies to. A gate answers `false` for a session that cannot feed the
capability. That is the whole of what it does — no page, metric, route or feature was
removed to produce this classification, and claude's own session still sees all 29.

## Two gates, and neither is derived from the other

[ADR 0040](../adrs/0040-three-providers-and-three-harnesses.md) holds that provider and
harness are two independent columns: the harness is never inferred from the provider, and
the provider is never inferred from the harness. Today's three pairs — Anthropic/Claude
Code, OpenAI/codex, Ox Alpha/opencode — are **data, not structure**. A capability that
read one axis off the other would work perfectly until a fourth pair arrived, and then be
silently wrong.

`stacks/claude/core/src/capabilities.ts` enforces that by shape rather than by convention:

- `capabilityAllowsProvider(id, provider)` takes a `ProviderId` and reads only the
  declaration's `provider` field. It has no harness in scope to consult.
- `capabilityAllowsHarness(id, harness)` takes a `HarnessId` and reads only the
  declaration's `harness` field. It has no provider in scope to consult.
- `ProviderId` and `HarnessId` are disjoint string unions, so passing one where the other
  belongs is a type error rather than a wrong answer.
- `isCapabilityAvailable(id, session)` is the only function that sees both axes, and all
  it does is require both gates to open. It reads neither declaration field itself, so it
  has no way to let one axis stand in for the other.

A capability that is genuinely both declares both, and both must hold.

## The provider axis

Ticket 01 landed `HarnessCapability` and `HarnessAdapter.supports()` but no provider
equivalent, so the provider axis is added here as `ProviderCapability` — a closed union
for the same reason ticket 01 closed its own, because a gate keyed on a free-form string
fails *open* on a typo and renders a surface against a session that cannot feed it.

| Provider capability | What it means |
|---|---|
| `additive-cache-counters` | Cache-read and cache-creation sit *outside* `input_tokens` |
| `wire-system-blocks` | The request's `system` field is an array of blocks that may carry `cache_control` |
| `prompt-cache-breakpoints` | The caller places `cache_control` breakpoints, and may place them wrongly |
| `subscription-usage-windows` | Rolling allowances reported through `anthropic-ratelimit-*` response headers |
| `oauth-usage-endpoint` | A first-party OAuth endpoint reporting the account's own usage |

Only Anthropic declares any of them. **openai and ox-alpha ship empty sets, and empty
means "not yet established" rather than "known absent"** — the same reading ticket 01's
codex and opencode harness adapters carry. This repository has captured Anthropic traffic
and none from the other two, so a `true` for them would be an invention rather than a
measurement. Empty gates the surface off, which is the safe direction.

The provider gate resolves through `providerRegistry`, so a provider with no registered
adapter answers `false` rather than consulting a table no adapter backed. The harness gate
delegates to `HarnessAdapter.supports()` rather than keeping a second table beside it —
one declaration of what Claude Code does, not two that can drift.

## The harness axis

`HarnessCapability` in `stacks/claude/core/src/harness-adapter.ts` carries eight members.
Ticket 01 landed the first three, which describe what a harness records about a session.
The five below them describe what it leaves on the device or puts into its own requests,
and they exist because four gates had been declaring `session-transcripts` as the nearest
member the union offered rather than the state they needed.

| Harness capability | What supporting it means |
|---|---|
| `session-transcripts` | Writes a per-thread transcript this repository can read back |
| `system-prompt-capture` | Captures the request's system prompt as a re-identifiable artifact |
| `skim-cache` | Supports the app-layer response cache, distinct from any prefix cache |
| `device-settings-file` | Keeps a machine-wide settings file declaring what it loads and what it withholds |
| `user-defined-commands` | Lets a user define named commands on disk, and marks their invocation in its own requests |
| `project-scoped-memory` | Keeps per-project instruction files on disk, keyed by the project |
| `installed-cli-bundle` | Ships its own program bundle on the device, readable as text |
| `harness-injected-request-content` | Injects content into its own requests its own settings cannot suppress |

The union stays **closed**, for the reason ticket 01 closed it: a gate keyed on a
free-form string fails *open* on a typo, rendering a surface against a session that cannot
feed it. Widening it is adding a member, never relaxing it to `string`.

**No member names a provider, and none is derived from one.** `device-settings-file` says
a settings file exists, not whose wire the session speaks — so a second harness that keeps
one declares it on its own evidence. codex and opencode still declare nothing at all, and
empty continues to mean "not yet established" rather than "known absent".

## The audit

Exhaustive over claude's capabilities: all 39 route modules (detail routes folded into the
station they belong to) plus the cross-cutting mechanisms that are not pages at all.
**"Neither" is the common case** — 13 of 29 — and it means ungated: the capability answers
`true` for every provider and every harness.

### Neither — ungated (13)

| Capability | Surface | Why |
|---|---|---|
| `overview` | `/` | Counts today's requests, tokens and cost from the audit corpus, which every pair produces |
| `trends` | `/trends`, `/trends/$metric` | Daily series of counts and bytes, not wire-shaped fields |
| `context-size` | `/context`, `/context/$file`, `/context/thread/$threadId` | Byte breakdown of a captured body — measured, not interpreted against a wire contract |
| `message-drill-down` | `/context/$file/message/$index`, `/context/$file/tool/$index` | Renders one captured message or tool call; the envelope differs, the drill-down does not |
| `tool-bloat` | `/tools`, `/trends/fixed-prefix/tool/$name` | Every harness sends tools and every provider accepts them |
| `pull-requests` | `/pull-requests` | Reads GitHub, which has nothing to do with either axis |
| `operator-notes` | `/notes` | Markdown an operator writes, about the device rather than any session |
| `background-jobs` | `/jobs`, `/jobs/$id` | The server's own job records |
| `concepts` | `/concepts`, `/concepts/$ord` | The hosted concept store, which no provider or harness feeds |
| `ideas-ledger` | `/ideas`, `/ideas/$slug` | A human-curated ledger |
| `request-audit-capture` | the per-request audit triple | Writes what went over the wire without interpreting it |
| `retention-lifecycle` | `server/src/retention.ts`, `archive.ts` | Storage policy by date and tier |
| `cost-and-pricing` | `core/src/pricing.ts`, `cost-rate.ts` | Keyed by provider and model **as data** — every provider gets rate rows, so the capability itself is ungated |

### Claude-Code-specific — gates on the HarnessAdapter (11)

| Capability | Surface | Harness gate |
|---|---|---|
| `session-transcripts` | `/sessions`, `/sessions/$id`, `/sessions/$id/errors` | `session-transcripts` |
| `live-session-graph` | `/sessions/graph` | `session-transcripts` |
| `session-suggestions` | `/advice`, `/advice/sessions/$bucket` | `session-transcripts` |
| `device-system-prompt` | `/system-prompt` | `system-prompt-capture` |
| `project-memory` | `/projects`, `/projects/$project`, `…/memory/$name` | `project-scoped-memory` |
| `hooks-and-plugins` | `/hooks-plugins` | `device-settings-file` |
| `slash-commands` | `/commands`, `/commands/$command`, `…/$runId` | `user-defined-commands` |
| `cli-internals` | `/cli-internals`, `/cli-internals/$id` | `installed-cli-bundle` |
| `skim-response-cache` | `/skim` | `skim-cache` |
| `proxy-filters` | `/filters` | `harness-injected-request-content` |
| `withheld-tools` | `/withheld` | `device-settings-file` |

**`session-transcripts` now means transcripts and nothing else.** The three capabilities
that declare it are the three that parse `logs/sessions/<threadId>.md`; the other eight
name the state they actually read. Six gates used to declare it without needing it, and
two of those six had never been listed as borrowing it — `withheld-tools` reads the same
`~/.claude/settings.json` the hooks inventory reads, and `proxy-filters` describes what
the proxy strips from requests the harness itself shapes. Both surfaced from re-deriving
every gate against its own module instead of against the list of known ones.

### Anthropic-wire-specific — gates on the ProviderAdapter (3)

| Capability | Surface | Provider gate | Evidence |
|---|---|---|---|
| `subscription-usage-windows` | `core/src/usage-limits.ts` | `subscription-usage-windows` | Reads `anthropic-ratelimit-*` response headers for the allowances a Claude subscription meters |
| `live-usage-poll` | `proxy/usage-live.ts` | `oauth-usage-endpoint` | Polls `api.anthropic.com/api/oauth/usage`, which no other provider exposes |
| `additive-cache-accounting` | `core/src/digest.ts` cache columns | `additive-cache-counters` | Adds cache-read and cache-creation to input, which is only correct where they sit outside it |

Each answers `false` for a codex or an ox session and does not render there. None of the
three is gated on the harness: an Anthropic-wire session under any harness would still
carry those headers, so inferring a harness gate from the provider one would have been
exactly the drift ADR 0040 forbids.

### Both — declares both, and both must hold (2)

| Capability | Surface | Provider gate | Harness gate |
|---|---|---|---|
| `wire-system-prompt-outline` | `/trends/avg-system-prompt/$hash`, `…/section/$index` | `wire-system-blocks` | `system-prompt-capture` |
| `prompt-cache-breakpoint-repair` | `proxy/cache-breakpoint.ts` | `prompt-cache-breakpoints` | `system-prompt-capture` |

**Both of these were found rather than invented, which is why there are only two.**
`core/src/wire-prompt.ts` parses the Anthropic `system` block array and its
`cache_control.ttl` — the provider's wire — while what it renders is a captured,
re-identifiable prompt, which is the harness's. `proxy/cache-breakpoint.ts` is blunter
still: its own header says it puts back a `cache_control` breakpoint (Anthropic's wire
field) that **the Claude Code client** intermittently drops (the harness). Neither gate
implies the other, and a session that has one but not the other gets nothing — which is
the case the tests pin, since today's one-to-one pairing means it would otherwise never
be exercised.

## What this ticket deliberately did not touch

`stacks/claude/admin/src/routes/` is untouched. Gating happens at the capability layer, so
a route module needs no edit to carry a classification, and a route module and this table
cannot drift into disagreeing about one page. Ticket 10 owns that directory.

`provider-adapter.ts` and `adapter-seam.ts` are imported and never edited: they are ticket
01's landed contract. `harness-adapter.ts` is ticket 01's too, and the widening above is
the one change made to it — five members added to `HarnessCapability` and declared by the
`claude-code` adapter. Nothing was removed from it, and the contract, the registry and
`stampFromHarness` are untouched.

## Where it lives

`stacks/claude/core/src/capabilities.ts`, re-exported from that package's `index.ts`, with
its tests in `stacks/claude/core/test/capabilities.test.ts`. The `HarnessCapability` union
it gates on lives in `stacks/claude/core/src/harness-adapter.ts`, tested in
`stacks/claude/core/test/harness-adapter.test.ts`. The module is pure — no
clock, no filesystem, no environment, no network, no runtime dependency — because
`stacks/claude/core/src` is bundled into the browser by the admin app.
