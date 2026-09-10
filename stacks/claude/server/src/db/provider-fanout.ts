import fs from 'node:fs';
import {
  type ProviderEnvelope,
  type ProviderId,
  providerAvailable,
  providerUnavailable,
  providerUnreachable,
  type StoreFault,
  storeAbsent,
  storeUnreadable,
} from '@agent-proxy/claude-core';

/**
 * The reader side of the typed store-absence envelope: turn one provider's read
 * into either data or the typed reason there is none, and run several such reads
 * without letting one failure reach another.
 *
 * The vocabulary itself is core's — `stacks/claude/core/src/store-absence.ts`,
 * which stays pure and browser-safe. What lives here is everything core may not
 * do: look at a file, classify a thrown SQLite error, and decide that a store
 * which is not on disk was never created.
 *
 * ## What this deliberately does not do
 *
 * **It never opens another stack's database.**
 * `docs/adrs/0046-narrowly-scoped-local-writes.md` gives each store one
 * controller, and `docs/adrs/0062-three-servers-and-one-moved-port.md` refuses
 * one process reading three stores twice over. So {@link fanOutProviders} takes a
 * *read function* per provider and never a path it opens on its own behalf: the
 * only store this server reads is claude's, and a sibling provider is reached
 * through its own server. That is also 0046 line 72 — "no cross-provider join at
 * the storage layer" — as a property of the code: each source is queried alone
 * and the combining happens above, in core's `aggregateFanout`.
 *
 * ## The three states, and where each one is decided
 *
 * 1. **Never created** — decided *before* the read, by looking for the file. A
 *    store that is not there cannot be opened, and reporting the resulting open
 *    error as a fault would turn ADR 0060's ignorable steady state into an alarm.
 * 2. **Unreadable** — decided from the thrown error, by {@link sqliteFaultFrom}.
 * 3. **Healthy with nothing in range** — not decided here at all. The read
 *    returns whatever it found, empty included, and empty travels as *data*.
 *    That is the state 0060 is most concerned to keep out of the other two.
 *
 * A fourth reason exists for a fault that is not the store's:
 * {@link ProviderUnreachableError} is mapped to `provider-unreachable`, never to
 * `store-unreadable`, which is the misattribution ADR 0062 exists to prevent.
 */

/**
 * Thrown by a read whose provider could not be reached at all — its server never
 * bound, is down, or is at another origin.
 *
 * It exists so a reader can say "this is not the store's fault" through the same
 * channel it reports everything else, rather than by returning a sentinel the
 * fan-out would have to guess at. Ticket 08's three-origin client is its main
 * caller; anything doing a remote read may throw it.
 */
export class ProviderUnreachableError extends Error {
  readonly origin: string;

  constructor(origin: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderUnreachableError';
    this.origin = origin;
  }
}

/**
 * A failed read, reduced to the two things a classifier reads from it.
 *
 * The catch clause is the I/O boundary, so whatever was thrown is parsed into
 * this named type **there**, once, and every function below takes the domain
 * type rather than an unparsed value.
 */
export interface StoreReadFailure {
  readonly message: string;
  /** The driver's error code, or empty when there was none. */
  readonly code: string;
}

/** `node:sqlite` attaches a string `code` beside the message; an ordinary `Error` has none. */
interface CodedError extends Error {
  readonly code?: string;
}

/**
 * Parse a caught value into {@link StoreReadFailure}. Inlined at each catch
 * rather than exported, because this is the boundary itself.
 */
function failureFrom(thrown: Error | CodedError): StoreReadFailure {
  // SAFETY: every `Error` is structurally a `CodedError` with the optional field
  // absent, so the read is a widening rather than a claim about what was thrown.
  const coded: CodedError = thrown;
  return { message: thrown.message, code: coded.code ?? '' };
}

/**
 * Which of ADR 0060's "locked, corrupt, or mid-migration" a failed read is.
 *
 * Matched on the message text as well as the code, because `node:sqlite`
 * surfaces the driver's own wording and the useful distinctions live there. A
 * failure matching none of them is `unknown` rather than being pushed into the
 * nearest bucket — a wrong cause sends an operator to the wrong fix.
 *
 * A missing table reads as `migrating` on purpose. A reader that opens a store
 * read-only applies no migration, so a table its schema step has not reached is
 * genuinely a store part-way up a ladder — and any reader for which an absent
 * table means "nothing recorded" should answer that itself, as data, rather than
 * throwing.
 */
export function sqliteFaultFrom(failure: StoreReadFailure): StoreFault {
  const text = `${failure.message} ${failure.code}`.toLowerCase().trim();
  if (text.includes('busy') || text.includes('locked')) return 'locked';
  if (text.includes('malformed') || text.includes('corrupt') || text.includes('not a database')) return 'corrupt';
  if (text.includes('no such table') || text.includes('no such column') || text.includes('schema version')) {
    return 'migrating';
  }
  return 'unknown';
}

/**
 * One provider's contribution to a fan-out, described rather than performed.
 *
 * `storePath` is what makes "never created" decidable. Give it for a local store
 * read and the file is checked before {@link ProviderStoreSource.read} is called;
 * leave it `null` — a remote origin, or a source that is not a file at all — and
 * the read is simply attempted, since a missing file is not a state that source
 * can be in.
 */
export interface ProviderStoreSource<T> {
  readonly provider: ProviderId;
  readonly storePath?: string | null;
  /** Read this provider's data. Returning empty is an answer; throwing is not. */
  read(): T | Promise<T>;
}

/**
 * Read one provider into an envelope. Never throws: every failure comes back as
 * a typed reason, which is what lets a fan-out run several of these and lose
 * none of them.
 */
export async function readProviderStore<T>(source: ProviderStoreSource<T>): Promise<ProviderEnvelope<T>> {
  const storePath = source.storePath ?? null;
  if (storePath !== null && !fs.existsSync(storePath)) {
    return providerUnavailable<T>(source.provider, storeAbsent(source.provider, storePath));
  }
  try {
    return providerAvailable<T>(source.provider, await source.read());
  } catch (thrown) {
    const failure: StoreReadFailure =
      thrown instanceof Error ? failureFrom(thrown) : { message: String(thrown), code: '' };
    if (thrown instanceof ProviderUnreachableError) {
      return providerUnavailable<T>(
        source.provider,
        providerUnreachable(source.provider, thrown.origin, failure.message),
      );
    }
    return providerUnavailable<T>(
      source.provider,
      storeUnreadable(source.provider, sqliteFaultFrom(failure), failure.message),
    );
  }
}

/**
 * Read several providers independently, one envelope each, in the order given.
 *
 * Each source is isolated by {@link readProviderStore}, so a provider that fails
 * contributes its reason and nothing more — the other providers' data is
 * untouched, which is ADR 0046's "a store going down costs only its own
 * provider's pages" as a property of this function rather than a hope about it.
 *
 * There is no combining here. Whatever wants one number across providers passes
 * the result to core's `aggregateFanout`, which propagates unavailability per
 * ADR 0044 instead of quietly totalling the providers that answered.
 */
export async function fanOutProviders<T>(
  sources: readonly ProviderStoreSource<T>[],
): Promise<readonly ProviderEnvelope<T>[]> {
  return await Promise.all(sources.map((source) => readProviderStore(source)));
}
