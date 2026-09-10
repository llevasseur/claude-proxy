import type { ProviderId } from './adapter-seam.js';
import { type JsonValue, jsonObject, textAt } from './json.js';
import {
  type ProviderEnvelope,
  type ProviderUnavailableReason,
  providerUnavailable,
  providerUnreachable,
  type StoreFault,
  storeAbsent,
  storeUnreadable,
} from './store-absence.js';

/**
 * Turning a **remote** read's failure into one of ADR 0060's typed reasons.
 *
 * `store-absence.ts` gives the vocabulary and
 * `server/src/db/provider-fanout.ts` classifies a *local* store read against it. This is
 * the third case and the one ADR 0062 introduced: a read performed over HTTP against
 * another provider's server, where the failure may be the store's, the server's, or the
 * dashboard's own idea of where that server lives.
 *
 * ## Why this is in core rather than in the dashboard that calls it
 *
 * Because it is the decision, not the plumbing. The rule that separates
 * `provider-unreachable` from `store-unreadable` is the whole substance of ADR 0062's
 * third consequence — "the dashboard must distinguish server not reachable from store
 * unreadable" — and it is pure: it reads a status, a message and an optionally-reported
 * reason, and returns a reason. Leaving it inline in a `fetch` wrapper would put the one
 * part worth testing inside the one part that cannot be, since claude's admin has no test
 * suite and `typecheck` is its only gate.
 *
 * Nothing here touches the network, the clock or the filesystem — the caller performs the
 * request and reduces it to {@link ProviderReadFailure}, which is a description of what
 * happened rather than a live handle on it.
 */

/**
 * The status a server answers when a route belongs to a provider it does not serve.
 *
 * **421 rather than 404**, because the path exists and is perfectly valid — this is just
 * not the server entitled to answer it. That distinction is the whole reason the dashboard
 * can tell "I am pointed at the wrong origin" apart from "this route was never declared",
 * and it is why the constant is shared rather than written as a bare number at both ends.
 */
export const MISDIRECTED_PROVIDER_STATUS = 421;

/**
 * What a failed remote read produced, reduced to the facts the rule below reads.
 *
 * Two shapes, because the difference between them is exactly the distinction being
 * preserved: `unreachable` means **no response existed** — the request never got an answer
 * — while `refused` means a server answered and said no. A caller that cannot tell those
 * apart has already lost the information this module exists to keep.
 */
export type ProviderReadFailure =
  /** The request produced no response at all: nothing bound, wrong port, DNS, CORS. */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** A response arrived carrying a non-OK status. */
  | {
      readonly kind: 'refused';
      readonly status: number;
      /** The server's own message, or a rendering of the status when it sent none. */
      readonly message: string;
      /** A typed reason the server reported, when it reported one. */
      readonly reported: ProviderUnavailableReason | null;
    };

/**
 * Why this provider has no data, from what its server did.
 *
 * The rule, in the order it is applied:
 *
 * 1. **No response** → `provider-unreachable`. The store was never consulted, so blaming
 *    it would be the misattribution ADR 0062 was written to prevent.
 * 2. **{@link MISDIRECTED_PROVIDER_STATUS}** → `provider-unreachable`. Something answered,
 *    but it does not serve this provider — so this provider was not reached. The origin is
 *    misconfigured; no store is at fault.
 * 3. **A reason the server typed itself** → that reason, unchanged. The server is the only
 *    party that can see why its own store failed, so its answer outranks any inference.
 * 4. **Anything else** → `store-unreadable` with fault `unknown`. The server answered, so
 *    it is reachable; the read failed for a reason it did not classify, and `unknown` is
 *    the honest fault rather than the nearest-looking one.
 */
export function remoteReadFailureReason(
  provider: ProviderId,
  origin: string,
  failure: ProviderReadFailure,
): ProviderUnavailableReason {
  if (failure.kind === 'unreachable') {
    return providerUnreachable(provider, origin, failure.detail);
  }
  if (failure.status === MISDIRECTED_PROVIDER_STATUS) {
    return providerUnreachable(provider, origin, `${origin} does not serve ${provider}: ${failure.message}`);
  }
  if (failure.reported !== null) return failure.reported;
  return storeUnreadable(provider, 'unknown', failure.message);
}

/**
 * Run one read per provider and keep every answer, whatever any of them does.
 *
 * The combinator a remote fan-out needs, and the guarantee it needs kept: **one provider's
 * failure never reaches another's result.** `Promise.all` alone would not give that — a
 * single rejection discards the settled answers beside it — so a read that rejects is
 * caught here and becomes that provider's typed reason. The caller's read is expected not
 * to reject; this makes the expectation enforced rather than documented, because the cost
 * of it being wrong once is the whole dashboard going blank instead of one card.
 *
 * That is ADR 0046's "a store going down costs only its own provider's pages" expressed as
 * a property of this function. The order of the result matches the order of `providers`, so
 * a caller can zip the two without matching on `provider`.
 *
 * Nothing is combined. Whatever wants one value across providers passes this to
 * `aggregateFanout`, which propagates unavailability instead of totalling whoever answered.
 */
export async function fanOutEnvelopes<T>(
  providers: readonly ProviderId[],
  read: (provider: ProviderId) => Promise<ProviderEnvelope<T>>,
): Promise<readonly ProviderEnvelope<T>[]> {
  return await Promise.all(
    providers.map(async (provider) => {
      try {
        return await read(provider);
      } catch (thrown) {
        const detail = thrown instanceof Error ? thrown.message : String(thrown);
        return providerUnavailable<T>(provider, storeUnreadable(provider, 'unknown', detail));
      }
    }),
  );
}

const STORE_FAULTS: readonly StoreFault[] = Object.freeze(['locked', 'corrupt', 'migrating', 'unknown'] as const);

/**
 * Parse a reason off the wire, or `null` for anything this vocabulary does not name.
 *
 * The input is a {@link JsonValue} rather than an `unknown`, because `json.ts` is already
 * this package's decoding boundary and the caller has already been through it — a payload
 * is one of six cases by the time it arrives here, not an open question. So this reads
 * fields with `textAt` and friends and never asks what anything's representation is.
 *
 * Parsed rather than trusted, because the body came from another origin and a renderer
 * downstream switches exhaustively over the members it knows — an unrecognised `code`
 * reaching it would fall through every branch and render nothing.
 *
 * **`fanout-incomplete` is deliberately rejected.** It is an aggregate's reason, and no
 * single provider is entitled to claim it; accepting one would let one server report a
 * state only produced by combining several of them.
 */
export function parseProviderUnavailableReason(value: JsonValue | undefined): ProviderUnavailableReason | null {
  const record = jsonObject(value);
  if (record === null) return null;

  const provider = textAt(record, 'provider');
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'ox-alpha') return null;

  switch (textAt(record, 'code')) {
    case 'store-absent': {
      const path = textAt(record, 'path');
      return storeAbsent(provider, path === '' ? null : path);
    }
    case 'store-unreadable': {
      const fault = textAt(record, 'fault');
      const known = STORE_FAULTS.find((candidate) => candidate === fault);
      return storeUnreadable(provider, known ?? 'unknown', textAt(record, 'detail'));
    }
    case 'provider-unreachable':
      return providerUnreachable(provider, textAt(record, 'origin'), textAt(record, 'detail'));
    default:
      return null;
  }
}
