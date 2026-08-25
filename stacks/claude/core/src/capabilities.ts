/**
 * Which of claude's capabilities render for a given session, decided on **two
 * gates that cannot see each other**.
 *
 * ## Gating is not deletion
 *
 * Every capability listed below still exists, still has its code, and still
 * renders for the sessions it applies to. Nothing here removes a page, a metric
 * or a route — a gate answers `false` for a session that cannot feed the
 * capability, and that is the whole of what it does.
 *
 * ## Two axes, and neither may be derived from the other
 *
 * `docs/adrs/0040-three-providers-and-three-harnesses.md` forbids inferring the
 * harness from the provider or the provider from the harness. Today's three
 * pairs — Anthropic/Claude Code, OpenAI/codex, Ox Alpha/opencode — are **data,
 * not structure**, so a capability that reads one axis off the other would work
 * perfectly until a fourth pair arrives and then be silently wrong.
 *
 * That is enforced here by shape rather than by convention:
 *
 * - {@link capabilityAllowsProvider} takes a `ProviderId` and reads only a
 *   declaration's `provider` field. It has no harness parameter to consult.
 * - {@link capabilityAllowsHarness} takes a `HarnessId` and reads only a
 *   declaration's `harness` field. It has no provider parameter to consult.
 * - `ProviderId` and `HarnessId` are disjoint string unions, so passing one
 *   where the other belongs does not typecheck.
 * - {@link isCapabilityAvailable} is the only function that sees both, and all
 *   it does is require both to hold. It cannot substitute one for the other,
 *   because it never reads either declaration field itself.
 *
 * A capability that is genuinely both declares both, and both must hold.
 *
 * ## The audit — every existing claude capability, classified
 *
 * "Neither" is the common case and means ungated: the capability answers `true`
 * for every provider and every harness. A silent gate is worse than no gate, so
 * the classification is written out here and again, in prose, in
 * `docs/features/capability-gating.md`.
 *
 * | Capability | Surface | Provider gate | Harness gate |
 * |---|---|---|---|
 * | `overview` | `/` | — | — |
 * | `trends` | `/trends`, `/trends/$metric` | — | — |
 * | `context-size` | `/context`, `/context/$file`, `/context/thread/$threadId` | — | — |
 * | `message-drill-down` | `/context/$file/message/$index`, `/context/$file/tool/$index` | — | — |
 * | `tool-bloat` | `/tools`, `/trends/fixed-prefix/tool/$name` | — | — |
 * | `pull-requests` | `/pull-requests` | — | — |
 * | `operator-notes` | `/notes` | — | — |
 * | `background-jobs` | `/jobs`, `/jobs/$id` | — | — |
 * | `concepts` | `/concepts`, `/concepts/$ord` | — | — |
 * | `ideas-ledger` | `/ideas`, `/ideas/$slug` | — | — |
 * | `request-audit-capture` | the per-request audit triple | — | — |
 * | `retention-lifecycle` | `server/src/retention.ts`, `archive.ts` | — | — |
 * | `cost-and-pricing` | `core/src/pricing.ts`, `cost-rate.ts` | — | — |
 * | `session-transcripts` | `/sessions`, `/sessions/$id`, `/sessions/$id/errors` | — | `session-transcripts` |
 * | `live-session-graph` | `/sessions/graph` | — | `session-transcripts` |
 * | `session-suggestions` | `/advice`, `/advice/sessions/$bucket` | — | `session-transcripts` |
 * | `device-system-prompt` | `/system-prompt` | — | `system-prompt-capture` |
 * | `project-memory` | `/projects`, `/projects/$project`, `…/memory/$name` | — | `session-transcripts` |
 * | `hooks-and-plugins` | `/hooks-plugins` | — | `session-transcripts` |
 * | `slash-commands` | `/commands`, `/commands/$command`, `…/$runId` | — | `session-transcripts` |
 * | `cli-internals` | `/cli-internals`, `/cli-internals/$id` | — | `session-transcripts` |
 * | `skim-response-cache` | `/skim` | — | `skim-cache` |
 * | `proxy-filters` | `/filters` | — | `session-transcripts` |
 * | `withheld-tools` | `/withheld` | — | `session-transcripts` |
 * | `subscription-usage-windows` | usage meters | `subscription-usage-windows` | — |
 * | `live-usage-poll` | `proxy/usage-live.ts` | `oauth-usage-endpoint` | — |
 * | `additive-cache-accounting` | cache-read/creation columns | `additive-cache-counters` | — |
 * | `wire-system-prompt-outline` | `/trends/avg-system-prompt/$hash`, `…/section/$index` | `wire-system-blocks` | `system-prompt-capture` |
 * | `prompt-cache-breakpoint-repair` | `proxy/cache-breakpoint.ts` | `prompt-cache-breakpoints` | `system-prompt-capture` |
 *
 * **The harness axis reuses ticket 01's closed `HarnessCapability` union rather
 * than growing one of its own.** That union has three members and this module
 * does not own the file it lives in, so a capability whose harness dependency is
 * not one of the three declares the nearest established member — which is why
 * the device-config surfaces (`hooks-and-plugins`, `slash-commands`,
 * `cli-internals`, `project-memory`) all gate on `session-transcripts`: what
 * they actually share is "this harness is the one whose device state and session
 * records this repository can read". Widening that union belongs to whichever
 * ticket owns `harness-adapter.ts`.
 *
 * **The route modules themselves are deliberately untouched.** Gating happens at
 * this capability layer, so `stacks/claude/admin/src/routes/` needs no edit to
 * carry a classification, and a route module and this table cannot drift into
 * disagreeing about one page.
 *
 * This module is pure: no clock, no filesystem, no environment, no network, and
 * no runtime dependency — `stacks/claude/core/src` is bundled into the browser.
 */

import type { HarnessId, ProviderId } from './adapter-seam.js';
import { type HarnessCapability, harnessRegistry } from './harness-adapter.js';
import { providerRegistry } from './provider-adapter.js';

/**
 * Something a **provider's wire contract** offers, which a capability may gate
 * on. The provider axis of what `HarnessCapability` is for the harness axis.
 *
 * Deliberately a closed union for the same reason ticket 01 closed its own: a
 * gate keyed on a free-form string fails *open* on a typo, rendering a surface
 * against a session that cannot feed it.
 */
export type ProviderCapability =
  /** Cache-read and cache-creation counters sit *outside* `input_tokens`. */
  | 'additive-cache-counters'
  /** The request's `system` field is an array of blocks that may carry `cache_control`. */
  | 'wire-system-blocks'
  /** The caller places `cache_control` breakpoints, and may place them wrongly. */
  | 'prompt-cache-breakpoints'
  /** Rolling subscription allowances reported through `anthropic-ratelimit-*` response headers. */
  | 'subscription-usage-windows'
  /** A first-party OAuth endpoint reporting the account's own usage figures. */
  | 'oauth-usage-endpoint';

/**
 * What each provider's wire is known to offer.
 *
 * **An empty set means "not yet established", never "known absent"** — the same
 * reading ticket 01's codex and opencode harness adapters carry. This repository
 * has captured Anthropic traffic and none from the other two, so declaring a
 * `true` for them would be an invention rather than a measurement. Empty gates
 * the surface off, which is the safe direction.
 */
const PROVIDER_CAPABILITIES: Readonly<Record<ProviderId, readonly ProviderCapability[]>> = Object.freeze({
  anthropic: Object.freeze([
    'additive-cache-counters',
    'wire-system-blocks',
    'prompt-cache-breakpoints',
    'subscription-usage-windows',
    'oauth-usage-endpoint',
  ] as const),
  openai: Object.freeze([]),
  'ox-alpha': Object.freeze([]),
});

/**
 * Whether a provider's wire offers a capability.
 *
 * Anchored on the **provider registry**, so a provider with no registered
 * adapter answers `false` rather than consulting a table the adapter never
 * backed. That is what makes this a gate on the `ProviderAdapter` rather than a
 * lookup that happens to be keyed the same way.
 */
export function providerSupports(provider: ProviderId, capability: ProviderCapability): boolean {
  if (providerRegistry.find(provider) === undefined) return false;
  return PROVIDER_CAPABILITIES[provider].includes(capability);
}

/**
 * Whether a harness supports a capability, asked of ticket 01's own adapter.
 *
 * This delegates to `HarnessAdapter.supports` rather than keeping a second table
 * beside it — one declaration of what Claude Code does, not two that can drift.
 * An unregistered harness answers `false`.
 */
export function harnessSupports(harness: HarnessId, capability: HarnessCapability): boolean {
  return harnessRegistry.find(harness)?.supports(capability) ?? false;
}

/** Every capability this repository ships, as the audit above enumerates them. */
export type CapabilityId =
  | 'overview'
  | 'trends'
  | 'context-size'
  | 'message-drill-down'
  | 'tool-bloat'
  | 'pull-requests'
  | 'operator-notes'
  | 'background-jobs'
  | 'concepts'
  | 'ideas-ledger'
  | 'request-audit-capture'
  | 'retention-lifecycle'
  | 'cost-and-pricing'
  | 'session-transcripts'
  | 'live-session-graph'
  | 'session-suggestions'
  | 'device-system-prompt'
  | 'project-memory'
  | 'hooks-and-plugins'
  | 'slash-commands'
  | 'cli-internals'
  | 'skim-response-cache'
  | 'proxy-filters'
  | 'withheld-tools'
  | 'subscription-usage-windows'
  | 'live-usage-poll'
  | 'additive-cache-accounting'
  | 'wire-system-prompt-outline'
  | 'prompt-cache-breakpoint-repair';

/**
 * One capability's classification.
 *
 * The two gate fields are **separate and independently nullable**, which is the
 * declaration-level reading of ADR 0040: there is no single "specific to" field
 * that would force one answer to stand for both, and no combined key. `null`
 * means ungated on that axis alone — it says nothing whatever about the other.
 */
export interface CapabilityDeclaration {
  readonly id: CapabilityId;
  /** How the capability is named to an operator. */
  readonly title: string;
  /** Where a reader finds it — a route path, or the module that implements it. */
  readonly surface: string;
  /** The provider capability this needs, or `null` when it needs none. */
  readonly provider: ProviderCapability | null;
  /** The harness capability this needs, or `null` when it needs none. */
  readonly harness: HarnessCapability | null;
  /** Why it is classified this way, in one sentence a reader can check. */
  readonly rationale: string;
}

function capability(
  id: CapabilityId,
  title: string,
  surface: string,
  provider: ProviderCapability | null,
  harness: HarnessCapability | null,
  rationale: string,
): CapabilityDeclaration {
  return Object.freeze({ id, title, surface, provider, harness, rationale });
}

/**
 * The audit, as data. Ordered ungated first, then harness-gated, then
 * provider-gated, then the two that are genuinely both — so the common case
 * reads first and the exceptions are visibly few.
 */
const DECLARATIONS: readonly CapabilityDeclaration[] = Object.freeze([
  capability(
    'overview',
    'Overview',
    '/',
    null,
    null,
    "Counts today's requests, tokens and cost from the audit corpus, which every pair produces.",
  ),
  capability(
    'trends',
    'Trends',
    '/trends, /trends/$metric',
    null,
    null,
    'Daily series over logged requests; the metrics are counts and bytes, not wire-shaped fields.',
  ),
  capability(
    'context-size',
    'Context size',
    '/context, /context/$file, /context/thread/$threadId',
    null,
    null,
    'Byte breakdown of a captured request body — measured, not interpreted against a wire contract.',
  ),
  capability(
    'message-drill-down',
    'Message drill-down',
    '/context/$file/message/$index, /context/$file/tool/$index',
    null,
    null,
    'Renders one captured message or tool call; the envelope differs per provider but the drill-down is generic.',
  ),
  capability(
    'tool-bloat',
    'Tool bloat',
    '/tools, /trends/fixed-prefix/tool/$name',
    null,
    null,
    'Sizes the tool schemas a request carries. Every harness sends tools and every provider accepts them.',
  ),
  capability(
    'pull-requests',
    'Pull request tree',
    '/pull-requests',
    null,
    null,
    'Reads GitHub, which has nothing to do with either axis.',
  ),
  capability(
    'operator-notes',
    'Operator notes',
    '/notes',
    null,
    null,
    'Markdown an operator writes. It is about the device, not about any session.',
  ),
  capability(
    'background-jobs',
    'Background jobs browser',
    '/jobs, /jobs/$id',
    null,
    null,
    "The server's own job records, produced by the server rather than by any session.",
  ),
  capability(
    'concepts',
    'Concepts',
    '/concepts, /concepts/$ord',
    null,
    null,
    'The hosted concept store, which no provider or harness feeds.',
  ),
  capability(
    'ideas-ledger',
    'Ideas ledger',
    '/ideas, /ideas/$slug',
    null,
    null,
    'A human-curated ledger, independent of what produced any record.',
  ),
  capability(
    'request-audit-capture',
    'Request audit capture',
    'the per-request audit triple',
    null,
    null,
    'Writes what went over the wire without interpreting it; the capture is the same job for any provider.',
  ),
  capability(
    'retention-lifecycle',
    'Retention lifecycle',
    'server/src/retention.ts, server/src/archive.ts',
    null,
    null,
    'Ages and archives stored records by date and tier, which is storage policy rather than wire or session shape.',
  ),
  capability(
    'cost-and-pricing',
    'Cost and pricing',
    'core/src/pricing.ts, core/src/cost-rate.ts',
    null,
    null,
    'Keyed by provider and model as data — every provider gets rate rows, so the capability itself is ungated.',
  ),
  capability(
    'session-transcripts',
    'Session transcripts',
    '/sessions, /sessions/$id, /sessions/$id/errors',
    null,
    'session-transcripts',
    'Parses `logs/sessions/<threadId>.md`, whose line-based shape is written for Claude Code sessions.',
  ),
  capability(
    'live-session-graph',
    'Live session graph',
    '/sessions/graph',
    null,
    'session-transcripts',
    'Draws the same transcripts as a graph, so it needs exactly what they need.',
  ),
  capability(
    'session-suggestions',
    'Session suggestions',
    '/advice, /advice/sessions/$bucket',
    null,
    'session-transcripts',
    'Mines transcripts for what an agent kept doing the slow way; with no transcripts there is nothing to mine.',
  ),
  capability(
    'device-system-prompt',
    'Device system prompt',
    '/system-prompt',
    null,
    'system-prompt-capture',
    'Reads `~/.claude/CLAUDE.md`, the instruction file a Claude Code session loads.',
  ),
  capability(
    'project-memory',
    'Project memory browser',
    '/projects, /projects/$project, /projects/$project/memory/$name',
    null,
    'session-transcripts',
    "Browses the per-project memory files Claude Code's own project directories hold.",
  ),
  capability(
    'hooks-and-plugins',
    'Hooks and plugins inventory',
    '/hooks-plugins',
    null,
    'session-transcripts',
    'Inventories `.claude/` hooks, plugins and skills — device state only this harness maintains.',
  ),
  capability(
    'slash-commands',
    'Slash commands',
    '/commands, /commands/$command, /commands/$command/$runId',
    null,
    'session-transcripts',
    "Records runs of the device's slash commands, which are a Claude Code construct.",
  ),
  capability(
    'cli-internals',
    'CLI internals',
    '/cli-internals, /cli-internals/$id',
    null,
    'session-transcripts',
    'Inspects the Claude Code CLI bundle itself; no other harness ships that bundle.',
  ),
  capability(
    'skim-response-cache',
    'Skim response cache',
    '/skim',
    null,
    'skim-cache',
    'The app-layer exact-repeat cache ticket 01 already declares as a harness capability.',
  ),
  capability(
    'proxy-filters',
    'Proxy filters',
    '/filters',
    null,
    'session-transcripts',
    'Counts the `<system-reminder>` blocks and withheld tools this harness injects into its own requests.',
  ),
  capability(
    'withheld-tools',
    'Withheld tools',
    '/withheld',
    null,
    'session-transcripts',
    'Lists tools the harness declined to add, which is a fact about the harness and not about the wire.',
  ),
  capability(
    'subscription-usage-windows',
    'Usage limit meters',
    'core/src/usage-limits.ts',
    'subscription-usage-windows',
    null,
    'Reads `anthropic-ratelimit-*` response headers for the 5-hour and weekly allowances a Claude subscription meters.',
  ),
  capability(
    'live-usage-poll',
    'Live usage poll',
    'proxy/usage-live.ts',
    'oauth-usage-endpoint',
    null,
    'Polls `api.anthropic.com/api/oauth/usage`, a first-party endpoint no other provider exposes.',
  ),
  capability(
    'additive-cache-accounting',
    'Additive cache accounting',
    'core/src/digest.ts cache columns',
    'additive-cache-counters',
    null,
    'Adds cache-read and cache-creation to input, which is only correct where they sit outside it.',
  ),
  capability(
    'wire-system-prompt-outline',
    'Wire system prompt outline',
    '/trends/avg-system-prompt/$hash, /trends/avg-system-prompt/$hash/section/$index',
    'wire-system-blocks',
    'system-prompt-capture',
    'Needs the `system` block array with its `cache_control.ttl` (the wire) and a captured, re-identifiable prompt (the harness).',
  ),
  capability(
    'prompt-cache-breakpoint-repair',
    'Prompt cache breakpoint repair',
    'proxy/cache-breakpoint.ts',
    'prompt-cache-breakpoints',
    'system-prompt-capture',
    'Puts back a `cache_control` breakpoint (the wire) that the Claude Code client intermittently drops (the harness).',
  ),
]);

const BY_ID: ReadonlyMap<CapabilityId, CapabilityDeclaration> = new Map(
  DECLARATIONS.map((declaration) => [declaration.id, declaration]),
);

/** Every capability id, in the audit's order. */
export const CAPABILITY_IDS: readonly CapabilityId[] = Object.freeze(DECLARATIONS.map((declaration) => declaration.id));

/** The full audit, for a reader or a page that wants to render the classification. */
export const CAPABILITIES: readonly CapabilityDeclaration[] = DECLARATIONS;

/** The declaration for a capability. Throws rather than guessing at an unknown id. */
export function capabilityDeclaration(id: CapabilityId): CapabilityDeclaration {
  const declaration = BY_ID.get(id);
  if (declaration === undefined) {
    throw new Error(`no capability declared for '${id}'`);
  }
  return declaration;
}

/**
 * Whether a capability's **provider** gate opens for this provider.
 *
 * Takes a `ProviderId` and reads only the declaration's `provider` field. There
 * is no harness in scope to consult, which is how ADR 0040's "never inferred
 * from the harness" is enforced here rather than merely intended.
 */
export function capabilityAllowsProvider(id: CapabilityId, provider: ProviderId): boolean {
  const required = capabilityDeclaration(id).provider;
  if (required === null) return true;
  return providerSupports(provider, required);
}

/**
 * Whether a capability's **harness** gate opens for this harness.
 *
 * The mirror of {@link capabilityAllowsProvider}, and independent of it in the
 * same way: a `HarnessId` in, only the declaration's `harness` field read.
 */
export function capabilityAllowsHarness(id: CapabilityId, harness: HarnessId): boolean {
  const required = capabilityDeclaration(id).harness;
  if (required === null) return true;
  return harnessSupports(harness, required);
}

/**
 * The two columns a record carries, per ADR 0040 — named separately because
 * neither may be derived from the other.
 */
export interface SessionAxes {
  readonly provider: ProviderId;
  readonly harness: HarnessId;
}

/**
 * Whether a capability renders for a session.
 *
 * The only function that sees both axes, and all it does is require both gates
 * to open. It reads neither declaration field itself, so it has no way to let
 * one axis stand in for the other — a capability that is genuinely both
 * declares both, and both must hold.
 */
export function isCapabilityAvailable(id: CapabilityId, session: SessionAxes): boolean {
  return capabilityAllowsProvider(id, session.provider) && capabilityAllowsHarness(id, session.harness);
}

/** Every capability that renders for a session, in the audit's order. */
export function capabilitiesFor(session: SessionAxes): readonly CapabilityId[] {
  return CAPABILITY_IDS.filter((id) => isCapabilityAvailable(id, session));
}
