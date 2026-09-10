import type { ProviderId } from './adapter-seam.js';

/**
 * The typed store-absence envelope: why a provider contributed no data, and the
 * one shape every cross-provider surface reads that answer from.
 *
 * `docs/adrs/0060-a-stores-absence-is-typed.md` — **a fan-out read never returns
 * a bare gap.** Each provider contributes either data or a typed reason. The
 * three states 0060 separates are separated here, and the separation is the
 * whole module:
 *
 * | State | Reason | What a human should do |
 * |---|---|---|
 * | Store never created | `store-absent` | Nothing. That proxy has never run. |
 * | Store present, unreadable | `store-unreadable` | Act on it — locked, corrupt, or mid-migration. |
 * | Store present, healthy, no rows | *none* — data, a genuine zero | Nothing. That provider served nothing. |
 *
 * The third row is the one most easily lost. A healthy store with no rows in
 * range is a **real measurement of zero**, so it travels as data and renders as
 * a zero series; collapsing it into either absence is, in 0060's words, "the
 * mirror of the same error: reporting a fault where the honest answer is that
 * nothing happened".
 *
 * ## Why this mirrors `CostUnavailableReason` rather than extending it
 *
 * `pricing.ts` says it outright: "The shape is the pattern, not just this enum:
 * a `code` discriminant plus the context needed to act on it. A store's absence
 * (ADR 0060) is a different kind of absence and gets its own union, written this
 * same way." So this file imports nothing from `pricing.ts` and adds no member to
 * its union. The two are one *idea* — an absence is typed, never a substituted
 * value — expressed twice because they are absences of different things and a
 * caller narrowing one has no business receiving the other's members.
 *
 * The parallel is deliberate down to the shapes: {@link ProviderEnvelope} is
 * `CostResult`'s "never both, never neither", and {@link aggregateFanout} is
 * `aggregateCost`'s propagation rule.
 *
 * ## Why the union is not called `StoreUnavailableReason`
 *
 * One of its members is deliberately **not** about the store.
 * `docs/adrs/0062-three-servers-and-one-moved-port.md` exists because a server
 * that failed to bind, reported as an unreadable store, is a *misattributed*
 * fault — "worse than an untyped gap", and this campaign's own doing. So
 * `provider-unreachable` sits beside the two store states and the type is named
 * for what it actually answers: why *this provider* has no data.
 *
 * ## This module is pure
 *
 * `stacks/claude/core/src` is bundled into the browser, so nothing here reads a
 * clock, a filesystem, an environment or a network. Producing a reason from a
 * live store is the server's job — `stacks/claude/server/src/db/provider-fanout.ts`.
 */

/**
 * What is wrong with a store that exists but cannot be read.
 *
 * ADR 0060 names three causes — "locked, corrupt, or mid-migration" — and they
 * are carried as data rather than folded into a message, because they are the
 * context an operator acts on: a lock clears on its own, a corrupt file is
 * restored, a half-migrated one finishes migrating. `unknown` is the honest
 * answer for a fault that matches none of them, and is never a default the other
 * three are guessed into.
 */
export type StoreFault = 'locked' | 'corrupt' | 'migrating' | 'unknown';

/**
 * Why a provider contributed no data. A `code` discriminant plus the context
 * needed to act on it — the same pattern as `CostUnavailableReason`, applied to
 * a second kind of absence.
 *
 * Adding a member here is a versioned API change, not a free addition: ADR 0060
 * puts this vocabulary on the wire and in the dashboard.
 */
export type ProviderUnavailableReason =
  /**
   * The store was never created — that proxy has never run. "No instrument", not
   * "no traffic". A steady state on any device running fewer than three proxies,
   * and one a human should be able to ignore.
   */
  | { readonly code: 'store-absent'; readonly provider: ProviderId; readonly path: string | null }
  /**
   * The store is there and cannot be read. A **fault a human should act on**,
   * and the state ADR 0046 means when it requires the failure to be legible as
   * "this provider is unavailable".
   */
  | {
      readonly code: 'store-unreadable';
      readonly provider: ProviderId;
      readonly fault: StoreFault;
      readonly detail: string;
    }
  /**
   * The provider's *server* could not be reached — it never bound, it is down,
   * or the origin is wrong. Distinct from `store-unreadable` because the fix is
   * different and because reporting it as a store fault is the misattribution
   * ADR 0062 exists to prevent.
   */
  | {
      readonly code: 'provider-unreachable';
      readonly provider: ProviderId;
      readonly origin: string;
      readonly detail: string;
    }
  /**
   * An aggregate could not be completed because at least one provider in it was
   * unavailable. Produced only by {@link aggregateFanout}; never attached to a
   * single provider's envelope.
   */
  | {
      readonly code: 'fanout-incomplete';
      readonly providers: readonly ProviderId[];
      readonly detail: string;
    };

/**
 * One provider's contribution to a fan-out: either data or the reason there is
 * none — **never both, never neither**, exactly as `CostResult` is written.
 *
 * `data` is `null` on the unavailable branch rather than zero, empty, or a gap.
 * That is ADR 0060's rule made unrepresentable-otherwise: a renderer cannot draw
 * an absence as a value it never received.
 */
export type ProviderEnvelope<T> =
  | { readonly provider: ProviderId; readonly data: T; readonly unavailableReason: null }
  | { readonly provider: ProviderId; readonly data: null; readonly unavailableReason: ProviderUnavailableReason };

/** A provider that answered. The data may be a genuine zero; that is still an answer. */
export function providerAvailable<T>(provider: ProviderId, data: T): ProviderEnvelope<T> {
  return Object.freeze({ provider, data, unavailableReason: null });
}

/** A provider that did not answer, with the typed reason it did not. */
export function providerUnavailable<T>(
  provider: ProviderId,
  unavailableReason: ProviderUnavailableReason,
): ProviderEnvelope<T> {
  return Object.freeze({ provider, data: null, unavailableReason });
}

/** The store was never created. `path` is where it would have been, when that is known. */
export function storeAbsent(provider: ProviderId, path: string | null = null): ProviderUnavailableReason {
  return Object.freeze({ code: 'store-absent', provider, path });
}

/** The store exists and cannot be read. */
export function storeUnreadable(provider: ProviderId, fault: StoreFault, detail: string): ProviderUnavailableReason {
  return Object.freeze({ code: 'store-unreadable', provider, fault, detail });
}

/** The provider's server could not be reached. Not a store fault (ADR 0062). */
export function providerUnreachable(provider: ProviderId, origin: string, detail: string): ProviderUnavailableReason {
  return Object.freeze({ code: 'provider-unreachable', provider, origin, detail });
}

/** Narrow an envelope to its available branch, keeping `data`'s type. */
export function isAvailable<T>(
  envelope: ProviderEnvelope<T>,
): envelope is { readonly provider: ProviderId; readonly data: T; readonly unavailableReason: null } {
  return envelope.unavailableReason === null;
}

/**
 * Whether this reason is a fault an operator should act on.
 *
 * `store-absent` is **false**, and that is ADR 0060's point rather than a
 * leniency: a dashboard that always shows two faults on a one-proxy device
 * trains its reader to ignore faults. The other three are true.
 */
export function requiresOperatorAttention(reason: ProviderUnavailableReason): boolean {
  return reason.code !== 'store-absent';
}

/**
 * How the picker in ADR 0041 shows a provider.
 *
 * Three values, because the picker's question is not the page's. `absent` is a
 * provider that has never run — shown as not configured, not as broken.
 * `degraded` is 0041's "degraded rather than empty", and it covers both faults:
 * an unreadable store and an unreachable server both mean this provider's pages
 * will not work now, even though they are fixed differently.
 */
export type ProviderPickerStatus = 'ready' | 'absent' | 'degraded';

export function pickerStatusFor<T>(envelope: ProviderEnvelope<T>): ProviderPickerStatus {
  if (envelope.unavailableReason === null) return 'ready';
  return envelope.unavailableReason.code === 'store-absent' ? 'absent' : 'degraded';
}

/** Providers the picker should mark degraded. Never includes one that simply has no store. */
export function degradedProviders<T>(envelopes: readonly ProviderEnvelope<T>[]): readonly ProviderId[] {
  return envelopes.filter((envelope) => pickerStatusFor(envelope) === 'degraded').map((envelope) => envelope.provider);
}

/** Providers with no data at all, whatever the reason. */
export function unavailableProviders<T>(envelopes: readonly ProviderEnvelope<T>[]): readonly ProviderId[] {
  return envelopes.filter((envelope) => !isAvailable(envelope)).map((envelope) => envelope.provider);
}

/** The data from the providers that answered, in fan-out order. */
export function availableData<T>(envelopes: readonly ProviderEnvelope<T>[]): readonly T[] {
  return envelopes.filter(isAvailable).map((envelope) => envelope.data);
}

/**
 * A cross-provider aggregate, or the reason there isn't one. `CostResult`'s
 * shape again, for the same reason: never both, never neither.
 */
export type FanoutAggregate<A> =
  | { readonly value: A; readonly unavailableReason: null }
  | { readonly value: null; readonly unavailableReason: ProviderUnavailableReason };

/**
 * Combine a fan-out into one value, **propagating unavailability** rather than
 * quietly dropping a provider.
 *
 * This is ADR 0044's rule — "an aggregate containing any unpriced record reports
 * unavailability rather than a partial total" — read across providers instead of
 * across records, and it is the same rule `aggregateCost` already applies. A
 * total computed over two of three stores is not a smaller total; it is a
 * different question, silently answered.
 *
 * A fan-out where every provider answered is combined, **including one where
 * every answer is zero**: that is a real measurement, so `combine` sees it and
 * the aggregate is a genuine zero rather than an absence. An empty fan-out is
 * combined too, for the same reason `aggregateCost` totals an empty list to
 * zero.
 */
export function aggregateFanout<T, A>(
  envelopes: readonly ProviderEnvelope<T>[],
  combine: (data: readonly T[]) => A,
): FanoutAggregate<A> {
  const missing = envelopes.filter((envelope) => !isAvailable(envelope));
  if (missing.length > 0) {
    const detail = missing
      .map((envelope) => `${envelope.provider}:${envelope.unavailableReason?.code ?? 'unknown'}`)
      .join(', ');
    return {
      value: null,
      unavailableReason: {
        code: 'fanout-incomplete',
        providers: Object.freeze(missing.map((envelope) => envelope.provider)),
        detail,
      },
    };
  }
  return { value: combine(availableData(envelopes)), unavailableReason: null };
}

/**
 * One sentence a per-provider surface can render, derived from the reason rather
 * than composed at each call site — so the page, the aggregate's explanation and
 * the picker's tooltip say the same thing about the same state.
 */
export function describeProviderUnavailable(reason: ProviderUnavailableReason): string {
  switch (reason.code) {
    case 'store-absent':
      return `${reason.provider} has no store yet — that proxy has not run`;
    case 'store-unreadable':
      return `${reason.provider}'s store is unreadable (${reason.fault}): ${reason.detail}`;
    case 'provider-unreachable':
      return `${reason.provider}'s server at ${reason.origin} is unreachable: ${reason.detail}`;
    case 'fanout-incomplete':
      return `aggregate unavailable — ${reason.providers.join(', ')} did not report (${reason.detail})`;
  }
}
