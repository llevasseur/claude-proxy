import { type CostUnavailableReason, describeCostUnavailable, isUnattributedRecord } from './pricing.js';
import {
  describeProviderUnavailable,
  type ProviderUnavailableReason,
  requiresOperatorAttention,
} from './store-absence.js';

/**
 * One rendering vocabulary for "we do not know".
 *
 * Two unions in this core already answer *why* a value is missing:
 * {@link CostUnavailableReason} for a cost ADR 0020 refuses to guess at, and
 * {@link ProviderUnavailableReason} for a store ADR 0060 refuses to render as a
 * gap. They are deliberately separate types — a caller narrowing one must never
 * receive the other's members — and this module does not merge them. It
 * projects each onto the small record a *surface* needs, so a page showing an
 * unpriced cost and a page showing an absent store speak with one voice instead
 * of inventing a second dialect for the second kind of absence.
 *
 * The projection is one-way and lossy on purpose. Anything that acts on an
 * absence — the picker's status, the aggregate's propagation decision — reads
 * the reason itself; only rendering reads a notice.
 */

/** Which union a notice came from. Kept so a surface can style the two alike without conflating them. */
export type UnavailableKind = 'cost' | 'provider';

/**
 * Whether an operator should act on this.
 *
 * `attention` is a fault with a fix: add the missing rate row, unlock the store,
 * start the server. `informational` is a state with nothing to do about it
 * *here* — either a steady condition (a proxy that has never run) or a state
 * derived from one reported elsewhere (a total that is unavailable because a
 * record beneath it is).
 *
 * Derived reasons are informational for the reason ADR 0060 gives for
 * `store-absent`: a dashboard that reports one fault twice — once at the record
 * and once at every total containing it — trains its reader to ignore faults.
 */
export type UnavailableSeverity = 'attention' | 'informational';

/**
 * An absence, as a surface renders it.
 *
 * `code` is stable and is what a stylesheet keys on; it is **not** always the
 * source reason's own discriminant, because one discriminant can carry two
 * facts (see `unattributed-record` below).
 */
export interface UnavailableNotice {
  readonly kind: UnavailableKind;
  readonly code: string;
  /** Two or three words. Badge-length, lower case; the sheet decides casing. */
  readonly label: string;
  /** One sentence, from the reason's own `describe*` function. */
  readonly detail: string;
  readonly severity: UnavailableSeverity;
}

/**
 * A cost absence as a notice.
 *
 * **`unknown-model` splits into two codes here, and that split is the point.**
 * The reason union says only that no row matched. A named model with no row is a
 * gap in the rate table an operator closes by adding one, which is ADR 0044's
 * "every model gets a price row". A record naming no model at all is a different
 * fact — nothing to add a row *for* — and `rateRowFor` withholds even a declared
 * fallback from it rather than pricing a record nothing is known about. Giving
 * the two one rendering would tell an operator to fix the first when they have
 * the second.
 */
export function costUnavailableNotice(reason: CostUnavailableReason): UnavailableNotice {
  const detail = describeCostUnavailable(reason);
  switch (reason.code) {
    case 'unknown-model':
      return isUnattributedRecord(reason)
        ? { kind: 'cost', code: 'unattributed-record', label: 'no model recorded', detail, severity: 'attention' }
        : { kind: 'cost', code: 'unknown-model', label: 'unpriced model', detail, severity: 'attention' };
    case 'missing-category-price':
      return { kind: 'cost', code: 'missing-category-price', label: 'rate incomplete', detail, severity: 'attention' };
    case 'aggregate-incomplete':
      return {
        kind: 'cost',
        code: 'aggregate-incomplete',
        label: 'total unavailable',
        detail,
        severity: 'informational',
      };
  }
}

/**
 * A provider absence as a notice.
 *
 * Severity comes from {@link requiresOperatorAttention} rather than from a
 * second table here, so this module cannot disagree with `store-absence.ts`
 * about which states are faults — `fanout-incomplete` is then overridden to
 * informational on the same derived-reason ground as `aggregate-incomplete`,
 * which is the one place the two disagree and it is stated rather than implied.
 */
export function providerUnavailableNotice(reason: ProviderUnavailableReason): UnavailableNotice {
  const detail = describeProviderUnavailable(reason);
  const severity: UnavailableSeverity =
    reason.code === 'fanout-incomplete' || !requiresOperatorAttention(reason) ? 'informational' : 'attention';
  switch (reason.code) {
    case 'store-absent':
      return { kind: 'provider', code: 'store-absent', label: 'no store yet', detail, severity };
    case 'store-unreadable':
      return { kind: 'provider', code: 'store-unreadable', label: 'store unreadable', detail, severity };
    case 'provider-unreachable':
      return { kind: 'provider', code: 'provider-unreachable', label: 'server unreachable', detail, severity };
    case 'fanout-incomplete':
      return { kind: 'provider', code: 'fanout-incomplete', label: 'total unavailable', detail, severity };
  }
}
