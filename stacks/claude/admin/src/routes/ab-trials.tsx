import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, useNavigate, useSearch } from '@tanstack/react-router';
import { GitCompare } from 'lucide-react';
import { useState } from 'react';
import { type AbChoice, type AbCommandTally, type AbTrialRow, deleteAbTrial, getAbTrials } from '../api';
import { QueryState } from '../components/QueryState';
import { SkeletonTableCard } from '../components/Skeleton';
import { fmtDuration, fmtInt, fmtLocalTsShort } from '../format';
import { type JsonRecord, textField } from '../json';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * Every `/ab` trial MyCommand recorded, one card per command.
 *
 * A trial runs two versions of one command from the same fixture or scenario, then a
 * blind judge picks between the outputs. The person's own pick, when they recorded one,
 * is the label — so whether it agreed with the judge is the column this page is for.
 *
 * The rows are ingested from the label records the Jev keep holds; opening one reads
 * that record for both full outputs. Deleting one removes the record itself.
 */

/** The cache key every trial read shares, so a delete refreshes the list wherever it happened. */
export const AB_TRIALS_KEY = ['ab-trials'] as const;

const CHOICE_LABEL = { a: 'A', b: 'B', tie: 'tie' } as const satisfies Record<AbChoice, string>;

/** A command as it is typed. */
export function commandLabel(command: string): string {
  return `/${command}`;
}

/** An arm, or `tie`. Null is no answer at all. */
export function ChoiceBadge({ choice }: { choice: AbChoice | null }) {
  if (choice === null) return <span className='muted'>—</span>;
  return <span className='badge neutral'>{CHOICE_LABEL[choice]}</span>;
}

/** Whether the person's pick matched the judge's verdict. */
export function AgreementBadge({ agrees }: { agrees: boolean | null }) {
  if (agrees === null) return <span className='muted'>no pick</span>;
  return agrees ? <span className='badge status-done'>agrees</span> : <span className='badge sev-warn'>disagrees</span>;
}

/**
 * Delete one trial, behind a second click. The record leaves the Jev keep, so this is
 * not undone by re-ingesting.
 */
export function TrialDelete({
  trial,
  onDeleted,
}: {
  trial: Pick<AbTrialRow, 'session' | 'id'>;
  onDeleted?: () => void;
}) {
  const client = useQueryClient();
  const [armed, setArmed] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteAbTrial(trial.session, trial.id),
    onSuccess: () => {
      setArmed(false);
      void client.invalidateQueries({ queryKey: AB_TRIALS_KEY });
      onDeleted?.();
    },
  });

  if (!armed) {
    return (
      <button
        type='button'
        className='btn-danger'
        title='Delete this trial’s record from the Jev keep'
        onClick={() => {
          remove.reset();
          setArmed(true);
        }}>
        Delete
      </button>
    );
  }

  return (
    <span className='job-delete-confirm'>
      <button type='button' className='btn-danger armed' disabled={remove.isPending} onClick={() => remove.mutate()}>
        {remove.isPending ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button type='button' className='link' disabled={remove.isPending} onClick={() => setArmed(false)}>
        cancel
      </button>
      {remove.error && <span style={{ color: 'var(--bad)' }}>{remove.error.message}</span>}
    </span>
  );
}

/** A figure for each arm, `A / B`, with an unknown one drawn as the absence it is. */
function Pair({ a, b, fmt }: { a: number | null; b: number | null; fmt: (n: number) => string }) {
  const cell = (value: number | null) => (value === null ? <span className='muted'>—</span> : fmt(value));
  return (
    <>
      {cell(a)} / {cell(b)}
    </>
  );
}

export function AbTrialsPage() {
  const search = useSearch({ from: '/ab-trials' });
  const navigate = useNavigate({ from: '/ab-trials' });
  const query = useQuery({ queryKey: AB_TRIALS_KEY, queryFn: getAbTrials });

  return (
    <section>
      <div className='pagehead'>
        <div className='pagehead-title'>
          <h1>A/B trials</h1>
          <div className='muted'>
            Two versions of one command, run from the same fixture or scenario and judged blind. Your pick is the label,
            so each trial shows whether it agreed with the judge.
          </div>
        </div>
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        busy={query.isFetching}
        skeleton={<SkeletonTableCard columns={SKELETON_COLUMNS} rows={6} />}>
        {query.data && (
          <TrialsBody
            trials={query.data.trials}
            commands={query.data.commands}
            substrate={query.data.meta.substrate}
            selected={search.command ?? null}
            onSelect={(command) => void navigate({ search: command === null ? {} : { command } })}
          />
        )}
      </QueryState>
    </section>
  );
}

/** The real table's columns, so the placeholder holds the same shape. */
const SKELETON_COLUMNS = [
  { head: '40%', cell: '72%', lines: 2 },
  { head: '52%', cell: '46%', lines: 2 },
  { head: '52%', cell: '46%', lines: 2 },
  { className: 'num', head: '70%', cell: '50%' },
  { className: 'num', head: '70%', cell: '50%' },
  { className: 'num', head: '70%', cell: '44%' },
] as const;

function TrialsBody({
  trials,
  commands,
  substrate,
  selected,
  onSelect,
}: {
  trials: AbTrialRow[];
  commands: AbCommandTally[];
  substrate: boolean;
  selected: string | null;
  onSelect: (command: string | null) => void;
}) {
  // Nothing recorded is the normal state on a machine that has never run `/ab`.
  if (!substrate || trials.length === 0) {
    return (
      <div className='card'>
        <div className='empty'>
          No trials yet. A trial appears here once <code>/ab</code> has recorded its pick with{' '}
          <code>my-command-tools jev-record label</code> and the keep has been ingested.
        </div>
      </div>
    );
  }

  const shown = selected === null ? commands : commands.filter((c) => c.command === selected);

  return (
    <>
      <div className='card'>
        <div className='card-head'>
          <h2>Commands</h2>
          <span className='range'>
            {fmtInt(trials.length)} trial{trials.length === 1 ? '' : 's'} across {fmtInt(commands.length)} command
            {commands.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className='badge-row'>
          <button type='button' className='btn-quiet' aria-pressed={selected === null} onClick={() => onSelect(null)}>
            All
          </button>
          {commands.map((c) => (
            <button
              key={c.command}
              type='button'
              className='btn-quiet'
              aria-pressed={c.command === selected}
              onClick={() => onSelect(c.command)}>
              {commandLabel(c.command)} · {fmtInt(c.trials)}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className='card'>
          <div className='empty'>
            No trials for {commandLabel(selected ?? '')}.{' '}
            <button type='button' className='link' onClick={() => onSelect(null)}>
              Show every command
            </button>
          </div>
        </div>
      ) : (
        shown.map((tally) => (
          <CommandTrials key={tally.command} tally={tally} trials={trials.filter((t) => t.command === tally.command)} />
        ))
      )}
    </>
  );
}

/** One command's trials, newest first. */
function CommandTrials({ tally, trials }: { tally: AbCommandTally; trials: AbTrialRow[] }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>{commandLabel(tally.command)}</h2>
        <span className='range'>
          {fmtInt(tally.trials)} trial{tally.trials === 1 ? '' : 's'}
          {tally.picked > 0 &&
            ` · you agreed with the judge on ${fmtInt(tally.agreed)} of ${fmtInt(tally.picked)} picks`}
        </span>
      </div>
      <div className='table-scroll'>
        <table className='table'>
          <thead>
            <tr>
              <th>Trial</th>
              <th>Judge</th>
              <th>Your pick</th>
              <th className='num'>Tokens A / B</th>
              <th className='num'>Took A / B</th>
              <th className='num'>Tools A / B</th>
              <th aria-label='Delete' />
            </tr>
          </thead>
          <tbody>
            {trials.map((trial) => (
              <tr key={`${trial.session}:${trial.id}`}>
                <td>
                  <Link
                    to='/ab-trials/$session/$id'
                    params={{ session: trial.session, id: String(trial.id) }}
                    className='link'>
                    {fmtLocalTsShort(trial.recordedAt)}
                  </Link>
                  <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
                    {[trial.args, trial.setup, trial.mode].filter(Boolean).join(' · ') || trial.session}
                  </div>
                </td>
                <td>
                  <ChoiceBadge choice={trial.verdict} />
                  {trial.confidence !== null && (
                    <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
                      {trial.confidence} confidence
                    </div>
                  )}
                </td>
                <td>
                  <ChoiceBadge choice={trial.pick} /> <AgreementBadge agrees={trial.agrees} />
                </td>
                <td className='num'>
                  <Pair a={trial.runs.a.tokens} b={trial.runs.b.tokens} fmt={fmtInt} />
                </td>
                <td className='num'>
                  <Pair a={trial.runs.a.durationMs} b={trial.runs.b.durationMs} fmt={fmtDuration} />
                </td>
                <td className='num'>
                  <Pair a={trial.runs.a.toolUses} b={trial.runs.b.toolUses} fmt={fmtInt} />
                </td>
                <td>
                  <TrialDelete trial={trial} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** `?command=` is the selected command, so a filtered view is linkable and survives a reload. */
export interface AbTrialsSearch {
  command?: string;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ab-trials',
  component: AbTrialsPage,
  staticData: { title: 'A/B trials' },
  validateSearch: (search: JsonRecord): AbTrialsSearch => {
    const command = textField(search, 'command')?.replace(/^\/+/, '');
    return command ? { command } : {};
  },
});

export const nav = {
  section: 'Learning',
  to: '/ab-trials',
  label: 'A/B trials',
  hint: 'command versions, judged',
  // Stays lit on a trial's own page.
  exact: false,
  icon: GitCompare,
} as const satisfies NavEntry;
