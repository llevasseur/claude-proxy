import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type AbRun, type AbSide, type AbTrialResponse, getAbTrial } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { Markdown } from '../components/Markdown';
import { QueryState } from '../components/QueryState';
import { SkeletonTextCard } from '../components/Skeleton';
import { fmtDuration, fmtInt, fmtLocalTs } from '../format';
import { rootRoute } from '../route-root';
import { AgreementBadge, ChoiceBadge, commandLabel, TrialDelete } from './ab-trials';

/**
 * One `/ab` trial, A beside B.
 *
 * The verdict comes first because it is what the trial decided: the judge's pick, how
 * sure it was, its reasons, and your pick beside it. Below that the two runs are
 * compared line for line, then both full outputs sit side by side. Everything here is
 * read from the trial's record in the Jev keep, not from the database.
 */

const SIDES = ['a', 'b'] as const satisfies readonly AbSide[];

export function AbTrialDetailPage() {
  const { session, id } = useParams({ from: '/ab-trials/$session/$id' });
  const navigate = useNavigate();
  const trialId = Number(id);
  const query = useQuery({ queryKey: ['ab-trial', session, trialId], queryFn: () => getAbTrial(session, trialId) });
  const data = query.data;
  const command = data ? commandLabel(data.trial.command) : null;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/ab-trials' className='link'>
          A/B trials
        </Link>
        {data && (
          <Link to='/ab-trials' search={{ command: data.trial.command }} className='link'>
            {command}
          </Link>
        )}
        <span className='crumb-current'>{data ? fmtLocalTs(data.trial.recordedAt) : `${session} #${id}`}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <div className='pagehead-title'>
          <h1>
            {command ?? 'Trial'}
            {data?.trial.args && <span className='muted'> {data.trial.args}</span>}
          </h1>
          {data && <div className='muted'>{setupLine(data)}</div>}
        </div>
        {data && (
          <TrialDelete
            trial={data.trial}
            // The whole list, since this may have been its command's only trial.
            onDeleted={() => void navigate({ to: '/ab-trials' })}
          />
        )}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SkeletonTextCard lines={8} />}>
        {data && (
          <>
            <Verdict data={data} />
            <Comparison data={data} />
            <div className='grid two'>
              {SIDES.map((side) => (
                <Output key={side} side={side} run={data.runs[side]} />
              ))}
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

/** What the trial ran from, in one line. */
function setupLine(data: AbTrialResponse): string {
  const parts = [fmtLocalTs(data.trial.recordedAt)];
  if (data.trial.mode) parts.push(`${data.trial.mode} mode`);
  if (data.scenario) parts.push(`scenario ${data.scenario}`);
  else if (data.fixture?.branch) {
    parts.push(`fixture ${data.fixture.branch}${data.fixture.sha ? ` @ ${data.fixture.sha.slice(0, 7)}` : ''}`);
  }
  return parts.join(' · ');
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className='stat-label'>{label}</div>
      <div className='stat-value'>{children}</div>
    </div>
  );
}

function Verdict({ data }: { data: AbTrialResponse }) {
  const { judge, trial } = data;
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Verdict</h2>
        {judge.shownFirst && (
          <span className='range'>
            the judge read {judge.shownFirst.toUpperCase()} first, without knowing which was which
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-9)' }}>
        <Figure label='Judge'>
          <ChoiceBadge choice={judge.verdict} />
        </Figure>
        <Figure label='Confidence'>{judge.confidence ?? <span className='muted'>—</span>}</Figure>
        <Figure label={data.pickBy ? `Pick (${data.pickBy})` : 'Your pick'}>
          <ChoiceBadge choice={trial.pick} />
        </Figure>
        <Figure label='Agreement'>
          <AgreementBadge agrees={trial.agrees} />
        </Figure>
      </div>
      {judge.reasons.length > 0 && (
        <>
          <h3>Reasons</h3>
          <ul>
            {judge.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      )}
      {data.rubric && (
        <p className='muted' style={{ marginBottom: 0 }}>
          <strong>Rubric:</strong> {data.rubric}
        </p>
      )}
    </div>
  );
}

/** A value that may be missing, drawn as an em dash when it is. */
function Maybe({ value }: { value: ReactNode }) {
  return value === null || value === undefined || value === '' ? <span className='muted'>—</span> : value;
}

/** A list cell: one line per entry, or nothing. */
function Lines({ items }: { items: string[] }) {
  if (items.length === 0) return <span className='muted'>—</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 'var(--space-7)' }}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** The metric rows, one function per row so both arms are drawn by the same code. */
const ROWS: readonly { label: string; cell: (run: AbRun, data: AbTrialResponse, side: AbSide) => ReactNode }[] = [
  {
    label: 'Version',
    cell: (_run, data, side) => {
      const version = data.versions[side];
      return (
        <>
          <span className='mono-break'>
            <Maybe value={version.ref} />
          </span>
          {version.lines !== null && <div className='muted'>{fmtInt(version.lines)} lines</div>}
        </>
      );
    },
  },
  { label: 'PR title', cell: (run) => <Maybe value={run.title} /> },
  { label: 'Tool uses', cell: (run) => <Maybe value={run.toolUses === null ? null : fmtInt(run.toolUses)} /> },
  { label: 'Tokens', cell: (run) => <Maybe value={run.tokens === null ? null : fmtInt(run.tokens)} /> },
  { label: 'Took', cell: (run) => <Maybe value={run.durationMs === null ? null : fmtDuration(run.durationMs)} /> },
  {
    label: 'Refusals',
    cell: (run) => (
      <>
        <Maybe value={run.refusals === null ? null : fmtInt(run.refusals)} />
        {run.refusalLines.length > 0 && <Lines items={run.refusalLines} />}
      </>
    ),
  },
  {
    label: 'Close',
    cell: (run) => (
      <>
        {run.close === null ? (
          <span className='muted'>—</span>
        ) : (
          <span className={`badge ${run.close === 'correct' ? 'status-done' : 'sev-warn'}`}>{run.close}</span>
        )}
        {run.closeReason && <div className='muted'>{run.closeReason}</div>}
      </>
    ),
  },
  { label: 'PR action', cell: (run) => <Maybe value={run.prAction} /> },
  { label: 'PRs', cell: (run) => <Lines items={run.prs} /> },
  { label: 'Skipped', cell: (run) => <Lines items={run.skipped} /> },
  {
    label: 'Diff',
    cell: (run) => (
      <span className='mono-break'>
        <Maybe value={run.diff} />
      </span>
    ),
  },
];

/** Who chose an arm, as badges on its column head. */
function Choosers({ data, side }: { data: AbTrialResponse; side: AbSide }) {
  return (
    <>
      {data.judge.verdict === side && <span className='badge neutral'>judge</span>}{' '}
      {data.trial.pick === side && <span className='badge status-done'>your pick</span>}
    </>
  );
}

function Comparison({ data }: { data: AbTrialResponse }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Runs</h2>
        {data.judge.verdict === 'tie' && <span className='range'>the judge called it a tie</span>}
      </div>
      <div className='table-scroll'>
        <table className='table'>
          <thead>
            <tr>
              <th />
              {SIDES.map((side) => (
                <th key={side} style={{ width: '45%' }}>
                  {side.toUpperCase()} <Choosers data={data} side={side} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope='row'>{row.label}</th>
                {SIDES.map((side) => (
                  <td key={side}>{row.cell(data.runs[side], data, side)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One arm's full final message. */
function Output({ side, run }: { side: AbSide; run: AbRun }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>{side.toUpperCase()} output</h2>
        {run.title && <span className='range'>{run.title}</span>}
      </div>
      {run.output ? <Markdown source={run.output} /> : <div className='empty'>This run recorded no output.</div>}
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ab-trials/$session/$id',
  component: AbTrialDetailPage,
  staticData: { title: 'A/B trial' },
});
