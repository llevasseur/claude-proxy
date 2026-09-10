/**
 * Sidecar v2 — the sanitized audit sidecar, with an explicit provider
 * discriminator. Sanitization itself is
 * `docs/adrs/0019-sanitized-audit-sidecars.md`: bodies, prompts and tool data
 * have no schema slot here, v1 or v2.
 *
 * ## What v2 adds, and what it deliberately does not
 *
 * v2 adds a five-key **provenance header** to the payload the proxy already
 * wrote: `schemaVersion`, `provider`, `harness`, `model` and `adapterVersion`.
 * It adds nothing else. The body — timestamps, token counts, byte counts, skim
 * state — is untouched, because a sidecar's privacy boundary is not what this
 * ticket is changing.
 *
 * `provider` and `harness` are **two independent fields**, and neither is
 * derived from the other, per
 * `docs/adrs/0040-three-providers-and-three-harnesses.md`. Nothing in this file
 * maps one to the other, and `readSidecar` demands both from its caller rather
 * than inferring the second from the first.
 *
 * `cost` and `pricing_source` are **absent, and their absence is the decision**
 * — `docs/adrs/0065-cost-is-resolved-at-read-time.md`. Both are functions of a
 * rate table an operator may edit at any moment, so a sidecar carrying them
 * would be an uninvalidated cache of mutable state. `assertSanitizedSidecar`
 * rejects them outright rather than merely omitting them, so a writer that
 * starts emitting one fails loudly instead of quietly freezing a price.
 *
 * ## How a reader tells v1 from v2
 *
 * From **one dedicated field and nothing else**: `schemaVersion`. A v1 sidecar
 * predates that field, so its *absence* is defined here, once, to mean version
 * 1 — that is the version signal itself, not a guess assembled from which other
 * keys happen to be present. `readSidecarSchemaVersion` is the only place in
 * this package that decides a version, and it never looks at `provider`,
 * `harness`, or any other key to do it. An unrecognised value is an error, not
 * a reason to fall back to v1: a sidecar from a future writer must not be read
 * as though it came from an older one.
 *
 * ## v1 sidecars are read, never rewritten
 *
 * Captured sidecars are the source of truth for this repository, so this is not
 * a migration and there is no upgrade-in-place function here. A v1 file carries
 * no discriminator, so its provider is resolved **at read time** from the
 * adapter that captured it, which the caller names. Every function in this file
 * is pure: `readSidecar` returns a new object and never mutates, reorders or
 * re-serialises what it was handed.
 *
 * ## Determinism
 *
 * This package is bundled into the browser by the admin app, so this module
 * reads no clock, no filesystem, no environment and no network, imports no Node
 * builtin, and takes no runtime dependency. Reading a sidecar *file* is the
 * caller's job; this module is handed the already-parsed value.
 *
 * ## Why the boundary lint rules are disabled for this file
 *
 * The four rules below all say the same thing: do not accept `unknown`, do not
 * hold an open dictionary, do not branch on `typeof` — **parse the payload at
 * its I/O boundary and work in domain types instead.** That is exactly what this
 * file does; it *is* that boundary. `readSidecar` takes the `JSON.parse` result
 * of a captured `.audit.json`, validates it, and returns `ReadSidecar`, a named
 * domain type. A parser cannot accept the domain type it exists to produce, so
 * on this file the rules fire on the remedy rather than on the defect.
 *
 * Scoped to this file and to these four rules by a comment rather than by
 * `.oxlintrc.json`, so it stays visible to anyone reading the module and does
 * not weaken the rules anywhere else. `require-safety-comment-for-type-assertion`
 * is deliberately **not** in the list: every assertion below carries a real
 * `SAFETY:` note naming the check that already narrowed it.
 */

// oxlint-disable anti-slop/no-unknown-parameters -- decoding boundary; see the note above.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- decoding boundary; see the note above.
// oxlint-disable anti-slop/no-runtime-typeof -- decoding boundary; see the note above.
// oxlint-disable anti-slop/no-known-value-widening -- decoding boundary; see the note above.

import type { HarnessId, ProviderId, RecordStamp } from './adapter-seam.js';
import { harnessRegistry } from './harness-adapter.js';
import { providerRegistry } from './provider-adapter.js';

/** The version a v1 sidecar reads as. No v1 file carries this value literally. */
export const SIDECAR_SCHEMA_V1 = 1 as const;

/** The version this repository writes today. */
export const SIDECAR_SCHEMA_V2 = 2 as const;

/** Every schema version a reader here accepts. */
export type SidecarSchemaVersion = typeof SIDECAR_SCHEMA_V1 | typeof SIDECAR_SCHEMA_V2;

/**
 * The five keys v2 adds. Closed on purpose: a sixth key in this header would be
 * a schema change, and it should fail rather than ride along unnoticed.
 */
export const SIDECAR_PROVENANCE_KEYS = Object.freeze([
  'schemaVersion',
  'provider',
  'harness',
  'model',
  'adapterVersion',
] as const);

/**
 * The keys v2 genuinely *adds* to a v1 body — which is the provenance header
 * minus `model`.
 *
 * `model` is in the header because a stamp needs it, but it is not new: claude's
 * sidecar has carried a top-level `model` since long before v2. So v2 promotes
 * it rather than introducing it, and `readSidecar` leaves it in the body it
 * returns. Stripping it would make a v2 body differ from the v1 body it was
 * built from by exactly one field, for no reason a reader could tell.
 * `toSidecarV2` is what guarantees the two cannot disagree.
 */
const SIDECAR_ADDED_KEYS = Object.freeze(['schemaVersion', 'provider', 'harness', 'adapterVersion'] as const);

/**
 * Keys a sidecar may never carry, at any depth.
 *
 * This is `docs/adrs/0019-sanitized-audit-sidecars.md` made executable: request
 * and response bodies have no schema slot, and this list is where that's enforced.
 *
 * **The list names only unambiguous offenders**, because a false positive here
 * rejects a real captured sidecar — the very files this repository treats as its
 * source of truth. So `tools`, `request`, `session` and `skim` are deliberately
 * *not* here: claude's sidecar has carried all four since long before this
 * ticket, and each holds counts and hashes rather than content (`tools` is
 * `{name, bytes, estTokens}`, `request` is four byte counts plus a system-prompt
 * *hash*). Generic words that are legitimate leaf names in that shape — `input`,
 * `output`, `text`, `name` — are absent for the same reason.
 *
 * `cost` and `pricingSource` sit here rather than in a separate check because
 * ADR 0065 makes them the same kind of mistake as a body: a field whose presence
 * is wrong, not merely unnecessary.
 */
export const FORBIDDEN_SIDECAR_KEYS: readonly string[] = Object.freeze([
  'access_token',
  'api_key',
  'apiKey',
  'authorization',
  'bearer',
  'body',
  'cookie',
  'cookies',
  'cost',
  'credentials',
  'headers',
  'messages',
  'pricing_source',
  'pricingSource',
  'prompt',
  'promptText',
  'proxy_authorization',
  'refresh_token',
  'request_body',
  'requestBody',
  'requestHeaders',
  'response_body',
  'responseBody',
  'responseHeaders',
  'secret',
  'set_cookie',
  'system_prompt',
  'systemPrompt',
  'tool_calls',
  'tool_definitions',
  'toolCalls',
  'toolDefinitions',
  'x_api_key',
]);

/**
 * Fold a key to the shape the blocklist is matched on: lowercase, with `-` and
 * `_` removed.
 *
 * **Exact case-sensitive matching was the hole.** `x-api-key` is the header this
 * proxy actually authenticates Anthropic with and is the likeliest credential to
 * leak; `set-cookie` is the real response-header spelling; and `Authorization`
 * and `Cookie` are the canonical HTTP casings, so all four walked past a list
 * that already carried their lowercase or underscored forms. Normalizing both
 * sides collapses every spelling of one name onto one entry.
 *
 * It widens nothing it should not: the real sidecar's own keys — `toolCount`,
 * `estTokens`, `cacheRead`, `totalBytes` — fold to strings that appear nowhere
 * on the list.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

/** The blocklist folded once, at module load, so matching is a set lookup. */
const NORMALIZED_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(FORBIDDEN_SIDECAR_KEYS.map(normalizeKey));

/** Raised for every rejection in this module. Never swallowed, never defaulted. */
export class SidecarValidationError extends Error {
  override readonly name = 'SidecarValidationError';
}

/** The provenance header a v2 sidecar carries, and the whole of what v2 adds. */
export interface SidecarProvenanceV2 {
  readonly schemaVersion: typeof SIDECAR_SCHEMA_V2;
  readonly provider: ProviderId;
  readonly harness: HarnessId;
  readonly model: string;
  readonly adapterVersion: number;
}

/**
 * The adapter pair that captured a file, named by the caller.
 *
 * This is what a v1 sidecar's provider resolves *from*. Both axes are required
 * for the reason ADR 0040 gives: a caller that cannot say which harness captured
 * a record does not know enough to read it, and guessing one from the other is
 * the inference that record forbids.
 */
export interface CapturingAdapters {
  readonly provider: ProviderId;
  readonly harness: HarnessId;
  /** The capturing adapter's version, which a v1 file does not record. */
  readonly adapterVersion: number;
}

/** Just enough of a registry to answer "is this id registered?". */
export interface RegisteredIds<TId> {
  ids(): readonly TId[];
}

export interface SidecarReadContext {
  /** Only consulted for a v1 sidecar, which carries no discriminator of its own. */
  readonly capturedBy: CapturingAdapters;
  /** Defaults to the shipped provider registry. */
  readonly providers?: RegisteredIds<ProviderId>;
  /** Defaults to the shipped harness registry. */
  readonly harnesses?: RegisteredIds<HarnessId>;
}

/** Where a resolved stamp's provider and harness actually came from. */
export type SidecarStampSource =
  /** Read from the file's own v2 discriminator. */
  | 'payload'
  /** Resolved at read time from the adapter that captured a v1 file. */
  | 'capturing-adapter';

export interface ReadSidecar {
  readonly schemaVersion: SidecarSchemaVersion;
  readonly stamp: RecordStamp;
  readonly stampSource: SidecarStampSource;
  /** The payload with the provenance header removed. Untouched for a v1 file. */
  readonly body: Readonly<Record<string, unknown>>;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SidecarValidationError(`${path} must be an object`);
  }
  // SAFETY: the guard above already rejected every non-object — null, arrays and
  // all primitives — so what remains is a plain object with string keys.
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SidecarValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

/**
 * The one place a sidecar's version is decided, from the one field that states
 * it. See the file header for why the absence of that field means 1.
 */
export function readSidecarSchemaVersion(value: unknown): SidecarSchemaVersion {
  const sidecar = asObject(value, 'sidecar');
  const declared = sidecar.schemaVersion;
  if (declared === undefined) return SIDECAR_SCHEMA_V1;
  if (declared === SIDECAR_SCHEMA_V1) return SIDECAR_SCHEMA_V1;
  if (declared === SIDECAR_SCHEMA_V2) return SIDECAR_SCHEMA_V2;
  throw new SidecarValidationError(
    `sidecar.schemaVersion ${JSON.stringify(declared)} is not a version this reader supports`,
  );
}

/**
 * Reject a payload carrying anything a sidecar must never persist.
 *
 * Walks the whole value, because a body nested two levels down is still a body.
 * Cycles are impossible in a value parsed from JSON, which is the only thing
 * this module is handed.
 */
export function assertSanitizedSidecar(value: unknown, path = 'sidecar'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSanitizedSidecar(entry, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (NORMALIZED_FORBIDDEN_KEYS.has(normalizeKey(key))) {
      throw new SidecarValidationError(`${path}.${key} is a field a sanitized sidecar must never carry`);
    }
    assertSanitizedSidecar(nested, `${path}.${key}`);
  }
}

/**
 * One check for an adapter version, wherever it came from.
 *
 * Shared rather than inlined because the two read paths get the value from
 * different places — the payload on v2, the capturing adapter on v1 — and a
 * field validated on one path and trusted on the other is validated nowhere a
 * caller can rely on.
 */
function assertAdapterVersion(value: unknown, path: string): number {
  // SAFETY: `Number.isSafeInteger` on the left of the `||` has already rejected
  // every non-number, so the comparison runs only on a proven number.
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SidecarValidationError(`${path} must be a positive safe integer`);
  }
  // SAFETY: `Number.isSafeInteger` above already established this is a number.
  return value as number;
}

function assertRegistered(context: SidecarReadContext, provider: ProviderId, harness: HarnessId): void {
  const providers = context.providers ?? providerRegistry;
  const harnesses = context.harnesses ?? harnessRegistry;
  if (!providers.ids().includes(provider)) {
    throw new SidecarValidationError(
      `sidecar.provider '${provider}' names no registered provider adapter — refusing to default it`,
    );
  }
  if (!harnesses.ids().includes(harness)) {
    throw new SidecarValidationError(
      `sidecar.harness '${harness}' names no registered harness adapter — refusing to default it`,
    );
  }
}

/**
 * Build a v2 sidecar from a body and the stamp of whatever produced it.
 *
 * Refuses a body that already carries a provenance key, so two writers can never
 * disagree about a record's provider inside one file.
 */
export function toSidecarV2<TBody extends Record<string, unknown>>(
  body: TBody,
  stamp: RecordStamp,
): Readonly<TBody & SidecarProvenanceV2> {
  assertSanitizedSidecar(body);
  // The writer holds the same two values to the standard the reader enforces, so
  // a payload this function accepts is one `readSidecar` can read back. Skipping
  // them here would let a bad `adapterVersion` be written and only fail at some
  // later read, with the offending value long out of reach.
  assertAdapterVersion(stamp.adapterVersion, 'stamp.adapterVersion');
  asNonEmptyString(stamp.model, 'stamp.model');
  for (const key of SIDECAR_PROVENANCE_KEYS) {
    if (key !== 'model' && key in body) {
      throw new SidecarValidationError(`sidecar body already carries the provenance key '${key}'`);
    }
  }
  // `model` is the one provenance key a v1 body already had, so a body may carry
  // it — but only saying the same thing the stamp says. Letting the stamp win
  // silently would resolve a real disagreement about which model produced a
  // record by overwriting the evidence.
  if ('model' in body && body.model !== stamp.model) {
    throw new SidecarValidationError(
      `sidecar body model ${JSON.stringify(body.model)} disagrees with the stamp's ${JSON.stringify(stamp.model)}`,
    );
  }
  return Object.freeze({
    ...body,
    schemaVersion: SIDECAR_SCHEMA_V2,
    provider: stamp.provider,
    harness: stamp.harness,
    model: stamp.model,
    adapterVersion: stamp.adapterVersion,
  });
}

/**
 * Read a sidecar of either version, resolving its provider without ever
 * rewriting the file it came from.
 *
 * A v2 file states its own provider and harness, and both must be registered —
 * an unregistered discriminator throws rather than falling back to the capturing
 * adapter, because silently reading one provider's record as another's is the
 * exact corruption the discriminator was added to prevent.
 *
 * A v1 file states neither, so both come from `context.capturedBy`.
 */
export function readSidecar(value: unknown, context: SidecarReadContext): ReadSidecar {
  const sidecar = asObject(value, 'sidecar');
  const schemaVersion = readSidecarSchemaVersion(sidecar);
  assertSanitizedSidecar(sidecar);

  if (schemaVersion === SIDECAR_SCHEMA_V1) {
    // A v1 file carries none of v2's discriminators by definition, so finding one
    // here means the version field is *missing*, not that the file is v1 — and
    // resolving from the capturing adapter would then quietly overwrite a stated
    // provider with a different one. That is the same misattribution the v2 path
    // refuses loudly, so it is refused loudly here too rather than half the time.
    // This is not a second version signal: the version was already decided above,
    // from `schemaVersion` alone. It is a consistency check on the result.
    for (const key of SIDECAR_ADDED_KEYS) {
      if (key !== 'schemaVersion' && key in sidecar) {
        throw new SidecarValidationError(
          `sidecar states no schemaVersion but carries '${key}' — refusing to read it as v1 and overwrite that value`,
        );
      }
    }
    assertRegistered(context, context.capturedBy.provider, context.capturedBy.harness);
    assertAdapterVersion(context.capturedBy.adapterVersion, 'capturedBy.adapterVersion');

    // The v1 payload is handed back as it arrived; nothing here rewrites a v1
    // sidecar. The one key dropped is a literally-stated `schemaVersion`, so that
    // `body` means "payload minus header" at both versions rather than only at v2.
    const v1Body: Record<string, unknown> = { ...sidecar };
    delete v1Body.schemaVersion;

    return Object.freeze({
      schemaVersion,
      stampSource: 'capturing-adapter' as const,
      stamp: Object.freeze({
        provider: context.capturedBy.provider,
        harness: context.capturedBy.harness,
        model: asNonEmptyString(sidecar.model, 'sidecar.model'),
        adapterVersion: context.capturedBy.adapterVersion,
      }),
      body: Object.freeze(v1Body),
    });
  }

  // SAFETY: both are widened from `string` to their id union on the strength of
  // `assertRegistered` on the very next line, which rejects anything the
  // registries do not name. Until that call returns, neither value is trusted —
  // which is why the assertion and the check are not separated.
  const provider = asNonEmptyString(sidecar.provider, 'sidecar.provider') as ProviderId;
  // SAFETY: the same invariant as the line above — widened on the strength of the
  // `assertRegistered` call below, which rejects any id the registries do not name.
  const harness = asNonEmptyString(sidecar.harness, 'sidecar.harness') as HarnessId;
  assertRegistered(context, provider, harness);
  const adapterVersion = assertAdapterVersion(sidecar.adapterVersion, 'sidecar.adapterVersion');

  const body: Record<string, unknown> = { ...sidecar };
  for (const key of SIDECAR_ADDED_KEYS) {
    delete body[key];
  }

  return Object.freeze({
    schemaVersion,
    stampSource: 'payload' as const,
    stamp: Object.freeze({
      provider,
      harness,
      model: asNonEmptyString(sidecar.model, 'sidecar.model'),
      adapterVersion,
    }),
    body: Object.freeze(body),
  });
}
