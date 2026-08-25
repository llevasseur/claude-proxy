/**
 * The vocabulary both adapter axes agree on — and deliberately nothing else.
 *
 * `provider-adapter.ts` and `harness-adapter.ts` are one file each and **neither
 * imports the other**. That acyclicity is the file-level reading of
 * `docs/adrs/0040-three-providers-and-three-harnesses.md`, and it is only
 * possible because the two id vocabularies and the record stamp that names both
 * live here. Putting `ProviderId` in the provider file and importing it from the
 * harness file would make the harness registry depend on the provider registry —
 * exactly the appearance that record exists to forbid.
 *
 * **Nothing here knows the pairing.** There is no map from a `ProviderId` to a
 * `HarnessId`, no combined `provider-harness` union, and no helper that derives
 * one from the other. Today's three pairs are three rows of data elsewhere; a
 * fourth pair is another row, not another code path.
 */

/**
 * A wire contract and a pricing axis.
 *
 * **Never inferred from a harness.** Codex is not OpenAI.
 */
export type ProviderId = 'anthropic' | 'openai' | 'ox-alpha';

/**
 * A session shape and a transcript format.
 *
 * **Never inferred from a provider.** Anthropic is not Claude Code.
 */
export type HarnessId = 'claude-code' | 'codex' | 'opencode';

/** Every provider this repository observes. Order is not meaningful. */
export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(['anthropic', 'openai', 'ox-alpha'] as const);

/** Every harness this repository observes. Order is not meaningful. */
export const HARNESS_IDS: readonly HarnessId[] = Object.freeze(['claude-code', 'codex', 'opencode'] as const);

/**
 * The four fields a record stores about what produced it, per the dividing line
 * in `docs/adrs/0065-cost-is-resolved-at-read-time.md`.
 *
 * `cost` and `pricing_source` are **absent, and their absence is the decision**:
 * both are functions of a rate table an operator may edit at any moment, so
 * freezing them here would be an uninvalidated cache of mutable state. They are
 * resolved at read time instead.
 *
 * `provider` and `harness` are two columns because 0040 forbids re-deriving
 * either from the other — which is why no function in this package produces a
 * stamp without being told both.
 */
export interface RecordStamp {
  readonly provider: ProviderId;
  readonly harness: HarnessId;
  readonly model: string;
  /** Version of the adapter that produced this record. */
  readonly adapterVersion: number;
}
