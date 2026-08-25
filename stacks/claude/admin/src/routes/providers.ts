/**
 * Which providers a page supports, declared as data beside the page's `route` and `nav`.
 *
 * A provider here is a provider in the sense of
 * [ADR 0040](../../../../../docs/adrs/0040-three-providers-and-three-harnesses.md): one
 * column, never a stack name and never a harness. `openai` is not `codex`, and a page that
 * reads Claude Code's own files is declaring something about the *pairing* that exists
 * today — three rows of data — rather than letting code infer one column from the other.
 *
 * The declaration lives on the module rather than inside its `nav`, because a page in no
 * rail section exports no `nav` and still has to say which providers it belongs to.
 */

/**
 * The three providers the fused repository observes, per ADR 0040. Adding a fourth is a row
 * here plus a declaration on each page that supports it — never a new code path.
 *
 * `as const` is load-bearing: it is what keeps `ProviderId` a union of literals rather than
 * `string`, and therefore what makes a typo in a page's declaration a compile error.
 */
export const PROVIDER_IDS = ['anthropic', 'openai', 'ox-alpha'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * The picker defaults to Anthropic
 * ([ADR 0041](../../../../../docs/adrs/0041-provider-picker-drives-the-navigation.md)) — the
 * stack with the largest corpus, and the dashboard the other two are measured against.
 */
export const DEFAULT_PROVIDER = 'anthropic' as const satisfies ProviderId;

/**
 * What a page's `providers` export must satisfy.
 *
 * Declare one with `as const satisfies ProviderSupport`, never `: ProviderSupport` — the
 * annotation widens the entries back to `ProviderId` and the registry loses which providers
 * a page actually named. This is the same discipline `NavEntry` requires, for the same
 * reason, and `registry.ts` asserts it at the type level.
 */
export type ProviderSupport = readonly [ProviderId, ...ProviderId[]];

/**
 * Every provider — the declaration for a model-agnostic page.
 *
 * Ideas, Concepts, Advice and the rest of the repository's own surface are not a provider's
 * data, so per ADR 0041 they neither disappear from the rail nor trigger the redirect.
 * Pages name this rather than spelling the list out, so a fourth provider reaches all of
 * them at once instead of through 11 edits that can each be missed.
 */
export const EVERY_PROVIDER = PROVIDER_IDS;
