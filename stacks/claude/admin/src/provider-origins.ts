import type { ProviderId } from '@agent-proxy/claude-core';
import { API_BASE } from './api';

/**
 * Where each provider's server lives.
 *
 * Three origins rather than one, because there are three servers:
 * [ADR 0062](../../../../docs/adrs/0062-three-servers-and-one-moved-port.md) refuses a
 * single process reading three stores, on
 * [ADR 0046](../../../../docs/adrs/0046-narrowly-scoped-local-writes.md)'s sole-controller
 * rule and on the blast radius one process would restore. So the *dashboard* is what spans
 * the providers, and it spans them over the network — each store still has exactly one
 * reader, which is its own stack's server.
 *
 * **Anthropic's entry is `API_BASE` itself, not a second copy of it.** claude's server is
 * this dashboard's own origin, so re-declaring its URL here would be the second source of
 * truth that drifts the first time someone sets `VITE_API_BASE` alone.
 *
 * The defaults are the ports `AGENTS.md` records, and one of them is recent: ox's server
 * answers on **8808**, not 8788, because ADR 0062 moved it so claude's and ox's servers can
 * be bound at once — which the picker requires and an override cannot deliver for a
 * checkout nobody has configured.
 */

// SAFETY: Vite types every key of `import.meta.env` it does not know about through an
// `any` index signature, so this narrows rather than widens. Vite substitutes the literal
// text at build time, leaving exactly two outcomes — the string that was in `.env`, or the
// key absent.
const configuredCodexBase = import.meta.env.VITE_CODEX_SERVER_URL as string | undefined;
// SAFETY: as above — an `any`-typed env key narrowed to the two outcomes Vite can produce.
const configuredOxBase = import.meta.env.VITE_OX_SERVER_URL as string | undefined;

/**
 * The origin serving each provider. Total over {@link ProviderId}, so adding a fourth
 * provider is a compile error here rather than a provider that silently resolves to
 * `undefined` and fans out against the string "undefined".
 */
export const PROVIDER_ORIGINS: Readonly<Record<ProviderId, string>> = Object.freeze({
  anthropic: API_BASE,
  openai: configuredCodexBase ?? 'http://localhost:4319',
  'ox-alpha': configuredOxBase ?? 'http://localhost:8808',
});

/** The origin for one provider. */
export function originFor(provider: ProviderId): string {
  return PROVIDER_ORIGINS[provider];
}

/**
 * The environment variable that overrides a provider's origin, for an error message that
 * tells a reader what to actually do about an unreachable server.
 *
 * A "provider unreachable" notice naming only the port sends its reader to look for a
 * process; naming the variable tells them how to point the dashboard at the one they have
 * already got running somewhere else.
 */
export function originSettingFor(provider: ProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'VITE_API_BASE';
    case 'openai':
      return 'VITE_CODEX_SERVER_URL';
    case 'ox-alpha':
      return 'VITE_OX_SERVER_URL';
  }
}
