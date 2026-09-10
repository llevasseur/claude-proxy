import { useQuery } from '@tanstack/react-query';
import { getPricingMix, type PricingMixModel, type PricingMixReport } from '../api';
import { fmtPct, fmtUsd } from '../format';
import { Skeleton, SkeletonText } from './Skeleton';

/**
 * Where this corpus's spend got its rates, and the stamp that says so per model.
 *
 * Two decisions govern everything here.
 *
 * `docs/adrs/0044-every-model-gets-a-price-row.md` makes a fallback-priced figure a
 * **normal** state and gives the stamp one job: showing "what share of a total rests
 * on fallback rates rather than published ones". So the mark is plainly visible and
 * plainly not an alarm — dashed and uncoloured rather than a red badge — and the
 * share it feeds is the card's headline rather than a detail.
 *
 * `docs/adrs/0065-cost-is-resolved-at-read-time.md` forbids storing either field.
 * The server re-resolves both on every call, so the only thing that could make this
 * card stale is **this** file caching the answer — which is why the query below runs
 * at `staleTime: 0` and refetches on mount and on focus. An operator who edits a
 * rate and comes back must see the new share, and a cached one would outlive the
 * fact it reports.
 */

/** The window this card answers for, stated on its face rather than assumed. */
const SCOPE_NOTE = 'Priced spend across the whole corpus, by where the rate came from';

/**
 * The mark on a price resolved from a proxy's blanket rate.
 *
 * Exported so any table that renders a per-model price can carry the same mark; the
 * copy is `<proxy> rate` rather than the wire form `fallback:<proxy>`, because
 * "fallback" reads as a defect to anyone who has not read ADR 0044 and the state is
 * not one. The proxy is named because a fallback under one provider says nothing
 * about another.
 */
export function RateStamp({ proxy, model }: { proxy: string; model?: string }) {
  // No leading sentence when no model is named: in the legend the stamp speaks for a
  // whole category, and "This model." there would be about nothing in particular.
  const subject = model === undefined ? '' : `No published row for ${model}. `;
  return (
    <span
      className='rate-stamp'
      title={`${subject}Priced at the blanket rate the ${proxy} proxy declares. An estimate, not a fault. Add a row on the Pricing page to replace it.`}>
      <span className='sr-only'>estimated at the </span>
      {proxy} rate
    </span>
  );
}

/** A priced figure, marked approximate when a blanket rate produced it. */
function Price({ row }: { row: PricingMixModel }) {
  if (row.cost === null) {
    // An unpriced model's own treatment belongs to another ticket; this card states
    // the fact and takes no view on how an absent cost should read.
    return <span className='muted'>not priced</span>;
  }
  const cost = fmtUsd(Number(row.cost));
  if (row.source !== 'fallback' || row.fallbackProxy === null) return <>{cost}</>;
  return (
    <>
      <RateStamp proxy={row.fallbackProxy} model={row.model} />
      <span className='rate-approx' aria-hidden='true'>
        ~
      </span>
      {cost}
    </>
  );
}

/** One fallback proxy's slice of priced spend, summed from the models it priced. */
interface ProxySlice {
  proxy: string;
  cost: number;
}

function fallbackSlices(models: readonly PricingMixModel[]): ProxySlice[] {
  const byProxy = new Map<string, number>();
  for (const row of models) {
    if (row.source !== 'fallback' || row.fallbackProxy === null || row.cost === null) continue;
    byProxy.set(row.fallbackProxy, (byProxy.get(row.fallbackProxy) ?? 0) + Number(row.cost));
  }
  return [...byProxy].map(([proxy, cost]) => ({ proxy, cost })).sort((a, b) => b.cost - a.cost);
}

export function RateCoverageCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['pricing-mix'],
    queryFn: getPricingMix,
    // ADR 0065: the answer is a function of a table an operator may edit at any
    // moment, so this card holds it for no time at all. Anything longer would
    // survive a rate edit and report a share that is no longer true.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  if (isLoading) return <RateCoverageSkeleton />;
  if (error) return <div className='card usage-note'>Rate coverage unavailable: {error.message}</div>;

  const report = data?.mix ?? null;
  if (report === null) {
    return (
      <div className='card rate-coverage'>
        <Head />
        <p className='muted'>No pricing store on this server yet.</p>
        <Foot />
      </div>
    );
  }
  return <Loaded report={report} />;
}

function Head() {
  return (
    <div className='card-head'>
      <h2>Rate coverage</h2>
      <span className='muted'>{SCOPE_NOTE}</span>
    </div>
  );
}

function Foot() {
  return (
    <div className='rate-coverage-foot'>
      {/* Deliberately not a link: the Pricing page is another ticket's route, and
          naming a route this branch does not declare would not compile. */}
      <span className='muted'>
        A blanket rate is an estimate, not a fault. Add a row on the Pricing page to replace it.
      </span>
    </div>
  );
}

function Loaded({ report }: { report: PricingMixReport }) {
  const published = Number(report.published.cost);
  const slices = fallbackSlices(report.models);
  const fallback = slices.reduce((sum, slice) => sum + slice.cost, 0);
  const priced = published + fallback;

  if (report.fallbackCostShare === null || priced === 0) {
    return (
      <div className='card rate-coverage'>
        <Head />
        <p className='muted'>Nothing priced yet.</p>
        <Foot />
      </div>
    );
  }

  const pct = (cost: number): number => (cost / priced) * 100;
  const label = [
    `${fmtPct(pct(published))} published rows`,
    ...slices.map((slice) => `${fmtPct(pct(slice.cost))} ${slice.proxy} rate`),
  ].join(', ');

  return (
    <div className='card rate-coverage'>
      <Head />

      <div className='stackbar rate-coverage-bar' role='img' aria-label={label}>
        <div className='stackbar-seg rate-seg-table' style={{ width: `${pct(published)}%` }} />
        {slices.map((slice) => (
          <div className='stackbar-seg rate-seg-fallback' key={slice.proxy} style={{ width: `${pct(slice.cost)}%` }} />
        ))}
      </div>

      <ul className='rate-coverage-legend'>
        <li>
          <span className='rate-swatch rate-seg-table' aria-hidden='true' />
          <span className='rate-legend-label'>Published rows</span>
          <span className='rate-legend-value'>{fmtUsd(published)}</span>
          <span className='rate-legend-share'>{fmtPct(pct(published))}</span>
        </li>
        {slices.length === 0 ? (
          // The category is shown empty rather than dropped, so a reader learns it
          // exists and is at zero instead of wondering where it went.
          <li>
            <span className='rate-swatch rate-seg-fallback' aria-hidden='true' />
            <span className='rate-legend-label rate-legend-empty'>No blanket rates used</span>
            <span className='rate-legend-value'>{fmtUsd(0)}</span>
            <span className='rate-legend-share'>{fmtPct(0)}</span>
          </li>
        ) : (
          slices.map((slice) => (
            <li key={slice.proxy}>
              <span className='rate-swatch rate-seg-fallback' aria-hidden='true' />
              <span className='rate-legend-label'>
                <RateStamp proxy={slice.proxy} />
              </span>
              <span className='rate-legend-value'>
                <span className='rate-approx' aria-hidden='true'>
                  ~
                </span>
                {fmtUsd(slice.cost)}
              </span>
              <span className='rate-legend-share'>{fmtPct(pct(slice.cost))}</span>
            </li>
          ))
        )}
      </ul>

      <table className='table rate-coverage-table'>
        <thead>
          <tr>
            <th>Model</th>
            <th className='num'>Spend</th>
          </tr>
        </thead>
        <tbody>
          {/* Rendered in the order the server sent: costliest first, unpriced last.
              That ordering is one decision in `summarizePricingMix`, and re-sorting
              here would be a second one free to drift from it. */}
          {report.models.map((row) => (
            <tr key={row.model}>
              <td className='rate-model'>{row.model}</td>
              <td className='num'>
                <Price row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Foot />
    </div>
  );
}

/** The card at its loaded shape, so the page does not resize when the share lands. */
function RateCoverageSkeleton() {
  return (
    <div className='card rate-coverage' aria-busy='true'>
      {/* No `.card-head` wrapper: its bottom margin would stack with the heading
          placeholder's own. */}
      <Skeleton w='34%' className='skeleton-h2' />
      {/* Empty: the bar's own border draws the slot it will fill. */}
      <div className='stackbar rate-coverage-bar' aria-hidden />
      {/* `SkeletonText` rather than loose bars — it supplies the grid and the gap
          between the lines, which a bare wrapper does not. */}
      <SkeletonText lines={3} />
    </div>
  );
}
