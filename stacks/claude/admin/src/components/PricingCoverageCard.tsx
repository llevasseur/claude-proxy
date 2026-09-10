import { providerUnavailableNotice, storeUnreadable, type UnavailableNotice } from '@agent-proxy/claude-core';
import { useQuery } from '@tanstack/react-query';
import { getPricingCoverage, type PricingCoverageReason, type PricingCoverageResponse } from '../api';
import { fmtInt, fmtPct } from '../format';
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
 */
export function usePricingCoverage(date: string | undefined) {
  return useQuery({
    queryKey: ['pricing', 'coverage', date ?? null],
    queryFn: () => getPricingCoverage(date),
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

  if (coverage.error) {
    // The rate tables live only in the database, so there is no file scan behind
    // this one and an empty answer would be a lie. The same treatment a cost uses
    // renders the store's absence — one vocabulary, per ADR 0060.
    const notice = providerUnavailableNotice(
      storeUnreadable('anthropic', 'unknown', 'pricing coverage could not be read from this server'),
    );
    return (
      <div className='card usage-meter coverage tone-warn'>
        <div className='usage-meter-head'>
          <span className='stat-label'>Pricing coverage</span>
        </div>
        <div className='coverage-readout'>
          <Unavailable notice={notice} />
        </div>
      </div>
    );
  }

  const data: PricingCoverageResponse | undefined = coverage.data;
  if (!data) return null;

  const { summary, reasons } = data.corpus;
  const { total, fromTable, fromFallback, unpriced } = summary;

  if (total === 0) {
    return (
      <div className='card usage-meter coverage tone-signal'>
        <div className='usage-meter-head'>
          <span className='stat-label'>Pricing coverage</span>
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
        <span className='stat-label'>Pricing coverage</span>
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
