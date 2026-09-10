/**
 * What codex's record tier stores about what produced a row.
 *
 * The vocabulary is the campaign's single adapter contract — `ProviderId`,
 * `HarnessId` and `RecordStamp` in `stacks/claude/core/src/adapter-seam.ts`.
 * The values below are restated rather than imported, for the same reason
 * claude's own `oxAlphaProviderAdapter` restates ox's reconciliation rule
 * instead of importing `stacks/ox-alpha/packages/core`: every core is a
 * per-stack package that must stay free of runtime dependencies, and
 * `docs/adrs/0061-three-schemas-three-ladders-one-contract.md` keeps the three
 * stores independent. The contract is shared; the wiring is not.
 *
 * A restated constant can drift from the contract silently, which is exactly
 * the defect ticket 02 found in the proxy's own hardcoded adapter version. So
 * `test/record-stamp.test.ts` pins `RECORD_ADAPTER_VERSION` against the
 * openai adapter's declared version by reading that file, and fails loudly
 * when the two disagree.
 *
 * `provider` and `harness` are two separate constants, and nothing here maps
 * one to the other. `docs/adrs/0040-three-providers-and-three-harnesses.md`
 * forbids inferring either from the other — Codex is not OpenAI — so changing
 * one is editing one constant, never following a lookup.
 */

/** The wire contract codex-proxy observes. A `ProviderId`. */
export const RECORD_PROVIDER = 'openai';

/** The harness whose traffic codex-proxy captures. A `HarnessId`. */
export const RECORD_HARNESS = 'codex';

/** Mirrors `openAiProviderAdapter.adapterVersion`. */
export const RECORD_ADAPTER_VERSION = 1;
