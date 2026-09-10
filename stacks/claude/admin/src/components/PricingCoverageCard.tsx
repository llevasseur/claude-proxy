import { providerUnavailableNotice, type UnavailableNotice } from '@agent-proxy/claude-core';
import { useQuery } from '@tanstack/react-query';
import type { PricingCoverageReason } from '../api';
import { fmtInt, fmtPct } from '../format';
import { readProvider } from '../provider-fanout';
import { Unavailable } from './Unavailable';

/**
 * What share of the corpus this proxy can price, and what the rest is waiting on.
 *
 * The card exists so the unpriced state is **discoverable** rather than only
 * encountered. Meeting a hollow pill on one row tells you that row is unpriced;
 * it gives you no way to ask how much else is like it, and
 * [ADR 0044](../../../../../docs/adrs/0044-every-model-gets-a-price-row.md)
 * line 71 says a share-of-source figure is exactly what the pricing stamp is for.
 *
 * The bar carries three named segments rather than one fill, because "priced" is
 * two different facts: a rate from the model's own row, and a rate from the
 * proxy's declared fallback — an estimate we stand behind but should be able to
 * see. A sibling ticket surfaces that fallback share; this one wires the unpriced
 * segment, and the fallback segment simply does not render while it is zero.
 */

/**
 * One query for both readers, keyed by the day so React Query serves the cost
 * tile and this card from a single fetch.
 *
 * It goes through `readProvider` rather than the plain `read` helper for one
 * reason, and it is the ticket's own rule turned on itself: this route answers a
 * failure with a **typed** `unavailableReason`, and `unwrap` reduces any error to
 * a message string. Reading it through the envelope keeps the server's own
 * classification — so a store that was never created is not reported as one that
 * is broken, which is the distinction ADR 0060 exists to preserve and which this
 * card would otherwise flatten while claiming to be the surface that does not.
 */
export function usePricingCoverage(date: string | undefined) {
  return useQuery({
    queryKey: ['pricing', 'coverage', date ?? null],
    queryFn: () => readProvider('anthropic', '/api/pricing/coverage', { date }),
    retry: false,
  });
}

/** A reason row as the shared treatment renders it. */
export function reasonNotice(reason: PricingCoverageReason): UnavailableNotice {
  return {
    kind: 'cost',
    code: reason.code,
    label: reason.label,
    detail: reason.detail,
    severity: reason.severity,
  };
}

/**
 * The card's title names the **gap**, not the coverage.
 *
 * A sibling card on this same page is called "Rate coverage" and answers a
 * genuinely different question — what share of *spend* rests on a fallback rate
 * rather than a published one. "Pricing coverage" beside it was a near-synonym
 * for a different fact, which is worse than a clash: two titles that sound alike
 * teach a reader the cards are interchangeable. This one exists to surface what
 * cannot be priced at all, so it says that, and "N% priced" stays the headline.
 */
const CARD_LABEL = 'Unpriced records';

/** How the meter presents itself: the chrome's tone class, and the chip's words. */
interface CoverageTone {
  readonly tone: 'good' | 'warn' | 'bad';
  readonly chip: string;
}

/**
 * Any unpriced record makes the window's total unavailable (ADR 0044), so there
 * is no "mostly fine" tier — the split is none, some, and a lot.
 */
function coverageTone(unpriced: number, total: number): CoverageTone {
  if (unpriced === 0) return { tone: 'good', chip: 'Fully priced' };
  return unpriced / total >= 0.2
    ? { tone: 'bad', chip: 'Largely unpriced' }
    : { tone: 'warn', chip: 'Total unavailable' };
}

export function PricingCoverageCard({ date }: { date?: string }) {
  const coverage = usePricingCoverage(date);
  const envelope = coverage.data;
  if (!envelope) return null;

  if (envelope.unavailableReason !== null) {
    // The rate tables live only in the database, so there is no file scan behind
    // this one and an empty answer would be a lie. The reason is the server's own
    // rather than one composed here, so a store that has never been created and a
    // store that is broken stay two states — and its severity, not a hardcoded
    // tone, decides how loud the card is.
    const notice = providerUnavailableNotice(envelope.unavailableReason);
    return (
      <div className={`card usage-meter coverage tone-${notice.severity === 'attention' ? 'warn' : 'signal'}`}>
        <div className='usage-meter-head'>
          <span className='stat-label'>{CARD_LABEL}</span>
        </div>
        <div className='coverage-readout'>
          <Unavailable notice={notice} />
        </div>
      </div>
    );
  }

  const { summary, reasons } = envelope.data.corpus;
  const { total, fromTable, fromFallback, unpriced } = summary;

  if (total === 0) {
    return (
      <div className='card usage-meter coverage tone-signal'>
        <div className='usage-meter-head'>
          <span className='stat-label'>{CARD_LABEL}</span>
        </div>
        {/* A real measurement of nothing, not an absence: there is no traffic to
            price yet, which is a different fact from traffic we cannot price. */}
        <div className='usage-meter-foot'>
          <span className='muted'>No records to price yet</span>
        </div>
      </div>
    );
  }

  const pct = (n: number) => (n / total) * 100;
  const tablePct = pct(fromTable);
  const fallbackPct = pct(fromFallback);
  const unpricedPct = pct(unpriced);
  const pricedShare = (fromTable + fromFallback) / total;
  const { tone, chip } = coverageTone(unpriced, total);
  // One decimal only in the narrow band where rounding would print "100% priced"
  // over a chip that says something is not.
  const digits = pricedShare > 0.99 && pricedShare < 0.999 ? 1 : 0;

  return (
    <div className={`card usage-meter coverage tone-${tone}`}>
      <div
        className='usage-bar coverage-bar'
        role='img'
        aria-label={`${fmtPct(tablePct)} table rate, ${fmtPct(fallbackPct)} fallback rate, ${fmtPct(unpricedPct)} unpriced`}>
        <span className='coverage-seg is-table' style={{ width: `${tablePct}%` }} />
        {fallbackPct > 0 && <span className='coverage-seg is-fallback' style={{ width: `${fallbackPct}%` }} />}
        {unpricedPct > 0 && <span className='coverage-seg is-unpriced' style={{ width: `${unpricedPct}%` }} />}
      </div>
      <div className='usage-meter-head'>
        <span className='stat-label'>{CARD_LABEL}</span>
        <span className='usage-chip'>{chip}</span>
      </div>
      <div className='coverage-readout'>
        <span className='usage-meter-value'>
          {fmtPct(pricedShare * 100, digits)} <span className='usage-meter-unit'>priced</span>
        </span>
      </div>
      <div className='usage-meter-foot'>
        <span className='muted'>{fmtInt(total)} records in the corpus</span>
        <span className='muted'>{unpriced === 0 ? 'every record has a rate' : `${fmtInt(unpriced)} unpriced`}</span>
      </div>
      {reasons.length > 0 && (
        <ul className='minilist coverage-reasons'>
          {reasons.map((reason) => (
            <li key={reason.code}>
              <Unavailable notice={reasonNotice(reason)} />
              <span>{fmtInt(reason.records)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
