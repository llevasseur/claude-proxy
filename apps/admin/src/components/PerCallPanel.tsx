import type { PerCallStats, UsageDigest } from '@claude-proxy/core';
import { Link } from '@tanstack/react-router';
import { fmtInt, fmtPct } from '../format';
import type { StatMetric } from '../metrics';
import { Skeleton, type SkeletonColumn, SkeletonNote, SkeletonTable } from './Skeleton';

/** The two cohorts a day's requests split into, in the order they are shown. */
const COHORTS = [
  {
    key: 'work' as const,
    label: 'Work',
    note: 'requests you made',
  },
  {
    key: 'classifier' as const,
    label: 'Permission classifier',
    note: 'auto-mode overhead, one per agent tool call',
  },
];

/**
 * Where a per-call mean comes from, and what was held out of it.
 *
 * The headline is a mean over work traffic only, so the cohort it excludes has
 * to be visible beside it — otherwise a shift in the ratio of classifier to work
 * traffic reads as the work itself getting cheaper or dearer.
 */
export function PerCallPanel({ digests, def }: { digests: UsageDigest[]; def: StatMetric }) {
  const pick = def.perCall;
  const day = digests.at(-1);
  if (!pick || !day) return null;
  const { classifier, all, identified } = day.perCall;

  return (
    <div className='grid wide-two'>
      <div className='card'>
        <div className='card-head'>
          <h2>Where the number comes from</h2>
          <span className='muted'>{day.date}</span>
        </div>
        <Composition day={day} def={def} pick={pick} />
        <CohortTable day={day} def={def} pick={pick} />
        {!identified && (
          <p className='muted mix-note'>
            No prompt outlines were available for {day.date}, so no request was <em>checked</em> against the classifier
            signature. Every request is counted as work — an empty classifier cohort here is an absence of evidence, not
            evidence of absence.
          </p>
        )}
        {identified && classifier.requests === 0 && (
          <p className='muted mix-note'>
            No classifier traffic on {day.date}. Either auto mode was off, or no agent tool call needed scoring.
          </p>
        )}
        {identified && classifier.requests > 0 && (
          <p className='muted mix-note'>
            Classifier calls were <strong>{fmtPct(share(classifier, all) * 100)}</strong> of the day's requests and{' '}
            <strong>{fmtPct(pctOfCost(classifier, all))}</strong> of its estimated cost. Turning auto mode off would
            remove them — and nothing else.
          </p>
        )}
      </div>

      <div className='card'>
        <h2>How this is computed</h2>
        {def.provenance ? (
          <Provenance def={def} />
        ) : (
          <div className='empty'>No provenance recorded for this metric.</div>
        )}
      </div>
    </div>
  );
}

function share(cohort: PerCallStats, all: PerCallStats): number {
  return all.requests > 0 ? cohort.requests / all.requests : 0;
}

function pctOfCost(cohort: PerCallStats, all: PerCallStats): number {
  return all.costTotal > 0 ? (cohort.costTotal / all.costTotal) * 100 : 0;
}

/** The one-paragraph answer: a mean over one cohort, with its denominator named. */
function Composition({ day, def, pick }: { day: UsageDigest; def: StatMetric; pick: (s: PerCallStats) => number }) {
  const { work, all } = day.perCall;
  const unit = def.perCallAdditive ? 'requests' : 'sessions';
  const denominator = def.perCallAdditive ? work.requests : work.sessions;

  return (
    <p className='muted mix-note'>
      <strong>{def.format(pick(work))}</strong> is the mean over <strong>{fmtInt(denominator)}</strong> work {unit} on{' '}
      {day.date} — not a running total.
      {all.requests > work.requests && (
        <>
          {' '}
          Counting every request instead would make it <strong>{def.format(pick(all))}</strong>, which moves whenever
          the ratio of classifier to work traffic moves rather than when the work does.
        </>
      )}
      {!def.perCallAdditive && work.sessions === 0 && (
        <> No request carried a session id, so there is nothing to divide by.</>
      )}
    </p>
  );
}

/**
 * The cohorts side by side. `Of the mean` is `share × value`, which sums to the
 * all-request figure, so it only appears for the per-request means — sessions
 * are not partitioned by cohort and admit no such decomposition.
 */
function CohortTable({ day, def, pick }: { day: UsageDigest; def: StatMetric; pick: (s: PerCallStats) => number }) {
  const { all } = day.perCall;
  const additive = def.perCallAdditive ?? false;

  return (
    <table className='table'>
      <thead>
        <tr>
          <th>Cohort</th>
          <th className='num'>Requests</th>
          <th className='num'>Share</th>
          <th className='num'>{def.label}</th>
          {additive && <th className='num'>Of the mean</th>}
        </tr>
      </thead>
      <tbody>
        {COHORTS.map((c) => {
          const cohort = day.perCall[c.key];
          const s = share(cohort, all);
          return (
            <tr key={c.key}>
              <td>
                {c.label}
                <div className='muted'>{c.note}</div>
              </td>
              <td className='num'>{fmtInt(cohort.requests)}</td>
              <td className='num'>{fmtPct(s * 100)}</td>
              <td className='num'>{cohort.requests === 0 ? '—' : def.format(pick(cohort))}</td>
              {additive && <td className='num'>{cohort.requests === 0 ? '—' : def.format(s * pick(cohort))}</td>}
            </tr>
          );
        })}
        <tr>
          <td>
            <strong>All requests</strong>
            <div className='muted'>what an unfiltered mean would report</div>
          </td>
          <td className='num'>{fmtInt(all.requests)}</td>
          <td className='num'>{fmtPct(100)}</td>
          <td className='num'>{all.requests === 0 ? '—' : def.format(pick(all))}</td>
          {additive && <td className='num'>{all.requests === 0 ? '—' : def.format(pick(all))}</td>}
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Where to go to act on a per-call number, per metric. Only `fixed-prefix` has a
 * drilldown of its own — nothing else in the app showed a tool's JSON schema;
 * the rest link into the existing raw views.
 */
const NEXT_STEPS: Record<string, { to: '/context' | '/sessions' | '/tools'; label: string; why: string }[]> = {
  'cost-per-call': [
    { to: '/sessions', label: 'Sessions', why: 'which threads spent the calls, and what they were doing' },
    { to: '/context', label: 'Context size', why: 'what a single request was carrying when it cost the most' },
  ],
  'fresh-input': [
    { to: '/context', label: 'Context size', why: 'the messages and tool results that were new that turn' },
  ],
  'calls-per-session': [{ to: '/sessions', label: 'Sessions', why: 'the round trips a piece of work actually took' }],
  'fixed-prefix': [{ to: '/tools', label: 'Tools', why: "every tool's size, beyond the day's biggest" }],
};

/** The existing views that open up what a per-call mean only summarises. */
export function PerCallNextSteps({ def }: { def: StatMetric }) {
  const steps = NEXT_STEPS[def.key];
  if (!steps || steps.length === 0) return null;
  return (
    <div className='card'>
      <h2>Where to look next</h2>
      <ul className='provenance-list'>
        {steps.map((s) => (
          <li key={s.to}>
            <Link className='link' to={s.to}>
              {s.label}
            </Link>{' '}
            — {s.why}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cohort, requests, share, value, contribution — the widest form the panel renders. */
const COHORT_COLUMNS: readonly SkeletonColumn[] = [
  { lines: 2 },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
];

/** Mirrors the loaded panel box for box, so the chart below it does not jump. */
export function PerCallSkeleton() {
  return (
    <div className='grid wide-two'>
      <div className='card'>
        <div className='card-head'>
          <h2>Where the number comes from</h2>
          <Skeleton w='5rem' />
        </div>
        <SkeletonNote className='muted mix-note' lines={2} />
        <SkeletonTable columns={COHORT_COLUMNS} rows={3} />
        <SkeletonNote className='muted mix-note' lines={2} />
      </div>
      <div className='card'>
        <h2>How this is computed</h2>
        <div className='provenance' aria-hidden>
          <h3>Formula</h3>
          <Skeleton w='90%' />
          <h3>Read from</h3>
          <SkeletonNote className='provenance-skeleton-note' lines={3} />
          <h3>Left out</h3>
          <SkeletonNote className='provenance-skeleton-note' lines={4} />
        </div>
      </div>
    </div>
  );
}

/** The formula, the sidecar fields behind it, and what it deliberately leaves out. */
function Provenance({ def }: { def: StatMetric }) {
  const p = def.provenance;
  if (!p) return null;
  return (
    <div className='provenance'>
      <h3>Formula</h3>
      <pre className='provenance-formula'>{p.formula}</pre>

      <h3>Read from</h3>
      <ul className='provenance-list'>
        {p.sources.map((s) => (
          <li className='mono' key={s}>
            {s}
          </li>
        ))}
      </ul>

      {p.exclusions && p.exclusions.length > 0 && (
        <>
          <h3>Left out</h3>
          <ul className='provenance-list'>
            {p.exclusions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {p.caveats && p.caveats.length > 0 && (
        <>
          <h3>What it cannot tell you</h3>
          <ul className='provenance-list'>
            {p.caveats.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
