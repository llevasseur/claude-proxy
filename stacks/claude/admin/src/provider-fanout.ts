import {
  type ApiProviderJsonGetPath,
  type ApiQueryValue,
  type ApiRouteParam,
  apiRouteUrl,
  fanOutEnvelopes,
  PROVIDER_IDS,
  type ProviderEnvelope,
  type ProviderId,
  parseProviderUnavailableReason,
  providerAvailable,
  providerUnavailable,
  remoteReadFailureReason,
} from '@agent-proxy/claude-core';
import type { ApiGetResponses } from './api';
import { errorMessage, isJsonRecord, readJsonBody } from './json';
import { originFor, originSettingFor } from './provider-origins';

/**
 * The dashboard's three-origin fan-out: ask each provider's own server the same question,
 * and return one typed envelope per provider.
 *
 * This is the client half of
 * [ADR 0062](../../../../docs/adrs/0062-three-servers-and-one-moved-port.md). **The merge
 * happens here, above the stores** — never at the storage layer, which
 * [ADR 0046](../../../../docs/adrs/0046-narrowly-scoped-local-writes.md) forbids outright
 * ("no cross-provider join at the storage layer"). Each origin is queried alone and answers
 * for its own store alone; a provider that fails contributes
 * [ADR 0060](../../../../docs/adrs/0060-a-stores-absence-is-typed.md)'s typed reason rather
 * than dropping silently out of the result.
 *
 * ## Why this file is thin
 *
 * The rule that separates "server unreachable" from "store unreadable" is not here — it is
 * `remoteReadFailureReason` in core, along with the parser for a reason off the wire. This
 * file performs the request and reduces it to the facts that rule reads, and nothing else.
 * That split is deliberate: claude's admin has no test suite and `typecheck` is its only
 * gate, so the decision worth testing lives where it can be, and what is left here is
 * plumbing a test would not have taught us anything about.
 *
 * ## Why this does not sum anything
 *
 * There is no total here and there is not meant to be.
 * [ADR 0064](../../../../docs/adrs/0064-tokens-do-not-aggregate-across-providers.md) says
 * tokens never aggregate across providers — a token is a different unit per tokenizer, so
 * one number spanning three of them measures nothing. This returns the three answers side
 * by side. The one legitimate cross-provider scalar is money, and core's `aggregateFanout`
 * is what combines that, propagating unavailability rather than quietly totalling whoever
 * happened to answer.
 */

/** The fetch this module uses. Injectable so a caller can drive it without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FanoutOptions {
  readonly fetchImpl?: FetchLike;
  /** Providers to ask, in the order the answers come back. Defaults to all three. */
  readonly providers?: readonly ProviderId[];
}

/**
 * Read one provider-scoped route from that provider's own server.
 *
 * **Never rejects.** Every outcome comes back as an envelope, including the transport
 * failure that is the whole reason this cannot be a plain `fetch` — a rejection here would
 * take down the sibling reads running beside it.
 */
export async function readProvider<P extends ApiProviderJsonGetPath>(
  provider: ProviderId,
  path: P,
  params: Partial<Record<ApiRouteParam<P>, ApiQueryValue>> = {},
  options: FanoutOptions = {},
): Promise<ProviderEnvelope<ApiGetResponses[P]>> {
  const origin = originFor(provider);
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${origin}${apiRouteUrl(path, params)}`);
  } catch (thrown) {
    // No response at all. The store was never consulted, so this must not be reported as
    // a store fault — and the message names the override, because a reader who sees
    // "unreachable" needs to know how to point the dashboard somewhere else.
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    return providerUnavailable(
      provider,
      remoteReadFailureReason(provider, origin, {
        kind: 'unreachable',
        detail: `${detail} — set ${originSettingFor(provider)} if it is elsewhere`,
      }),
    );
  }

  if (res.ok) {
    // SAFETY: `ApiGetResponses[P]` is fixed by the literal path the caller declared, so
    // this restates the response contract the server owns for that path rather than
    // guessing at it — the same assertion `api.ts` makes for a single-origin read.
    return providerAvailable(provider, (await res.json()) as ApiGetResponses[P]);
  }

  const body = await readJsonBody(res);
  return providerUnavailable(
    provider,
    remoteReadFailureReason(provider, origin, {
      kind: 'refused',
      status: res.status,
      message: errorMessage(body) ?? `HTTP ${res.status}`,
      reported: parseProviderUnavailableReason(isJsonRecord(body) ? body.unavailableReason : undefined),
    }),
  );
}

/**
 * Ask every provider the same question at once, and keep all the answers.
 *
 * `Promise.all` is safe precisely because {@link readProvider} never rejects: one provider
 * being down costs that provider's data and nothing else, which is ADR 0046's "a store
 * going down costs only its own provider's pages" as a property of this function rather
 * than a hope about it.
 *
 * The result is in the order the providers were given, so a caller can zip it against its
 * own list without matching on `provider`.
 */
export async function fanOutRoute<P extends ApiProviderJsonGetPath>(
  path: P,
  params: Partial<Record<ApiRouteParam<P>, ApiQueryValue>> = {},
  options: FanoutOptions = {},
): Promise<readonly ProviderEnvelope<ApiGetResponses[P]>[]> {
  const providers = options.providers ?? PROVIDER_IDS;
  return await fanOutEnvelopes(providers, (provider) => readProvider(provider, path, params, options));
}
