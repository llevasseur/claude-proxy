import { type JobTone, jobStateTone, type LivenessState } from '@claude-proxy/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { JobDeleteResult, JobSummary } from '../api';
import { deleteJob, getJobs } from '../api';
import { LivenessBadge } from '../components/LivenessBadge';
import { QueryState } from '../components/QueryState';
import { type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtLocalTsShort } from '../format';

/**
 * "Jobs" — every background job directory under `~/.claude/jobs` on this device.
 *
 * A filesystem view, not a traffic one: a job directory is Claude Code's own scratch
 * space for a background session, written by the daemon on the machine. Nothing here
 * passes through the proxy, so this page reports what is *on disk* — including the
 * directories left behind after their job is gone.
 *
 * It is also the one page that can *change* the disk: each row deletes its job
 * directory for real (`rm -r`, no trash), armed by a second click, and refused by the
 * server while the job is still running.
 */

/** Badge class per state tone; the tones themselves come from core. */
const TONE_BADGES: Record<JobTone, string> = {
  busy: 'sev-info',
  done: 'absent',
  blocked: 'was-present',
  failed: 'sev-high',
  idle: 'neutral',
  unknown: 'neutral',
};

export function StateBadge({ state }: { state: string }) {
  const tone = jobStateTone(state);
  return <span className={`badge ${TONE_BADGES[tone]}`}>{state || 'no state'}</span>;
}

/** The last segment of a job's working directory — which checkout it ran in. */
export function cwdLabel(cwd: string): string {
  if (cwd === '') return '—';
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function JobsPage() {
  const query = useQuery({ queryKey: ['jobs'], queryFn: getJobs });
  const data = query.data;
  const jobs = data?.jobs ?? [];

  return (
    <section>
      <div className='pagehead'>
        <h1>Jobs</h1>
        <div className='muted'>
          Every background job directory in <span className='rule-name'>{data?.meta.jobsDir ?? '~/.claude/jobs'}</span>{' '}
          — device-wide, whichever project it ran in.
        </div>
      </div>

      <div className='card' style={{ marginBottom: 16 }}>
        <div className='leak-note'>
          <strong>What's on disk, not what's on the wire.</strong> A job directory is Claude Code's own scratch space
          for a background session — a <span className='rule-name'>state.json</span> it rewrites as it goes, a{' '}
          <span className='rule-name'>timeline.jsonl</span> of its state changes, and a{' '}
          <span className='rule-name'>tmp/</span> holding whatever the run built. The daemon writes all of it locally,
          so unlike the rest of the dashboard none of it comes through the proxy. Directories whose job is gone stay
          behind, and are listed here as <strong>husks</strong>.
        </div>
        <div className='leak-note'>
          <strong>State is what a job says; liveness is what its transcripts do.</strong> A{' '}
          <span className='rule-name'>state.json</span> is the job's own claim about itself, and it freezes at whatever
          it last wrote — a job that died mid-step still reads <span className='rule-name'>working</span> forever. The{' '}
          <strong>Liveness</strong> column is derived from outside it instead: how long ago the session's transcripts
          last grew, rolled up across the whole fan-out. <span className='rule-name'>quiet</span> means no new step for
          a while — busy or stalled — never that anything is known to be dead.
        </div>
        <div className='leak-note danger-note'>
          <strong>Deleting is permanent.</strong> The <span className='rule-name'>Delete</span> on a row removes that
          job's whole directory from <span className='rule-name'>~/.claude/jobs</span> — its state, its timeline and
          everything under its <span className='rule-name'>tmp/</span>. There is no trash and no undo. A job that is
          still running can't be deleted: stop it first, or its daemon loses the record it is writing.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<JobsSkeleton />}>
        {!data ? null : (
          <>
            <div className='grid stats'>
              <StatTile label='Jobs' value={fmtInt(data.meta.total)} sub='directories on disk' />
              <StatTile label='Running' value={fmtInt(data.meta.running)} sub='in a working state' />
              <StatTile label='Live' value={fmtInt(data.meta.live)} sub='transcript still growing' />
              <StatTile label='Husks' value={fmtInt(data.meta.husks)} sub='no readable state' />
              <StatTile label='On disk' value={fmtBytes(data.meta.bytes)} sub={`${fmtInt(data.meta.files)} files`} />
            </div>

            {jobs.length === 0 ? (
              <div className='card empty'>
                No job directories in <span className='rule-name'>{data.meta.jobsDir}</span>.
              </div>
            ) : (
              <JobsTable jobs={jobs} />
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** `JobsTable`'s columns, down to the delete button's own narrow one. */
const JOB_COLUMNS: SkeletonColumn[] = [
  { cell: '58%' },
  { cell: '40%' },
  { cell: '40%' },
  { cell: '46%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '44%' },
  { className: 'num', cell: '56%' },
  { className: 'job-delete-head', head: '0', cell: '3.5rem' },
];

function JobsSkeleton() {
  return (
    <>
      <SkeletonStats count={5} />
      <div className='card'>
        <SkeletonTable columns={JOB_COLUMNS} rows={8} />
      </div>
    </>
  );
}

type SortKey = 'name' | 'state' | 'liveness' | 'cwd' | 'files' | 'bytes' | 'activity';
type SortDir = 'asc' | 'desc';

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  state: 'asc',
  // Ascending puts the branches still going at the top, which is the reason to sort by it.
  liveness: 'asc',
  cwd: 'asc',
  files: 'desc',
  bytes: 'desc',
  activity: 'desc',
};

/** What a job is called: its name if it has one, else its id. */
function jobLabel(job: JobSummary): string {
  return job.name || job.id;
}

/** Sort order for the liveness column: what is still going, then what might be, then what is over. */
const LIVENESS_ORDER: Record<LivenessState, number> = { running: 0, quiet: 1, unknown: 2, finished: 3 };

/** Signed comparison for a column, ascending. */
function compare(a: JobSummary, b: JobSummary, key: SortKey): number {
  switch (key) {
    case 'name':
      return jobLabel(a).localeCompare(jobLabel(b));
    case 'state':
      return a.state.localeCompare(b.state);
    case 'liveness':
      return LIVENESS_ORDER[a.liveness.state] - LIVENESS_ORDER[b.liveness.state];
    case 'cwd':
      return cwdLabel(a.cwd).localeCompare(cwdLabel(b.cwd));
    case 'files':
      return a.files - b.files;
    case 'bytes':
      return a.bytes - b.bytes;
    default:
      return a.activity.localeCompare(b.activity);
  }
}

function JobsTable({ jobs }: { jobs: JobSummary[] }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'activity', dir: 'desc' });
  /** The row whose delete is armed — one at a time, cleared on any outcome. */
  const [armed, setArmed] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<JobDeleteResult | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteJob(id),
    onSuccess: (res) => {
      setArmed(null);
      setDeleted(res.deleted);
      // The server already re-listed after removing — seed rather than refetch.
      client.setQueryData(['jobs'], res.jobs);
    },
  });

  const sorted = useMemo(() => {
    const rows = [...jobs];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return rows;
  }, [jobs, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>
          {jobs.length} job{jobs.length === 1 ? '' : 's'}
        </h2>
        <span className='muted'>click a column to sort · click a row to browse its files</span>
      </div>
      {deleted && (
        <div className='job-delete-done'>
          Deleted <strong>{deleted.name || deleted.id}</strong> — {fmtInt(deleted.files)} file
          {deleted.files === 1 ? '' : 's'}, {fmtBytes(deleted.bytes)} freed from{' '}
          <span className='rule-name'>{deleted.path}</span>.
          <button type='button' className='link' onClick={() => setDeleted(null)}>
            dismiss
          </button>
        </div>
      )}
      {remove.error && <div className='job-delete-error'>Delete failed — {(remove.error as Error).message}</div>}
      <table className='table'>
        <thead>
          <tr>
            <SortHeader label='Job' sortKey='name' sort={sort} onSort={onSort} />
            <SortHeader label='State' sortKey='state' sort={sort} onSort={onSort} />
            <SortHeader label='Liveness' sortKey='liveness' sort={sort} onSort={onSort} />
            <SortHeader label='Ran in' sortKey='cwd' sort={sort} onSort={onSort} />
            <SortHeader label='Files' sortKey='files' sort={sort} onSort={onSort} className='num' />
            <SortHeader label='Size' sortKey='bytes' sort={sort} onSort={onSort} className='num' />
            <SortHeader label='Last active' sortKey='activity' sort={sort} onSort={onSort} className='num' />
            <th className='job-delete-head' aria-label='Delete' />
          </tr>
        </thead>
        <tbody>
          {sorted.map((job) => (
            <tr
              key={job.id}
              className='clickable'
              onClick={() => navigate({ to: '/jobs/$id', params: { id: job.id } })}>
              <td>
                <Link
                  to='/jobs/$id'
                  params={{ id: job.id }}
                  className='link job-title'
                  onClick={(e) => e.stopPropagation()}>
                  {jobLabel(job)}
                </Link>
                {job.name !== '' && <div className='muted mono-break job-id'>{job.id}</div>}
                {job.detail !== '' && <div className='job-detail'>{job.detail}</div>}
              </td>
              <td>
                <StateBadge state={job.state} />
                {!job.stateReadable && <div className='leak-note'>husk — no state.json</div>}
              </td>
              <td>
                <LivenessBadge liveness={job.liveness} />
                {job.threads > 0 && (
                  <div className='muted job-threads'>
                    {fmtInt(job.threads)} transcript{job.threads === 1 ? '' : 's'}
                  </div>
                )}
              </td>
              <td>
                <span title={job.cwd}>{cwdLabel(job.cwd)}</span>
              </td>
              <td className='num'>{fmtInt(job.files)}</td>
              <td className='num'>{fmtBytes(job.bytes)}</td>
              <td className='num muted'>{fmtLocalTsShort(job.activity)}</td>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the cell is not clickable — this only keeps a click off the row's own handler */}
              <td className='job-delete-cell' onClick={(e) => e.stopPropagation()}>
                <DeleteControl
                  job={job}
                  armed={armed === job.id}
                  pending={remove.isPending && remove.variables === job.id}
                  onArm={() => {
                    setDeleted(null);
                    remove.reset();
                    setArmed(job.id);
                  }}
                  onCancel={() => setArmed(null)}
                  onConfirm={() => remove.mutate(job.id)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The per-row delete CTA. Two clicks, never one: the first arms the row, the second
 * does it. A running job has no armed state at all — the server would refuse it, so
 * the button says why instead of failing after the fact.
 */
function DeleteControl({
  job,
  armed,
  pending,
  onArm,
  onCancel,
  onConfirm,
}: {
  job: JobSummary;
  armed: boolean;
  pending: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const running = jobStateTone(job.state) === 'busy';

  if (running) {
    return (
      <button type='button' className='btn-danger' disabled title='still running — stop it before deleting'>
        Delete
      </button>
    );
  }

  if (!armed) {
    return (
      <button type='button' className='btn-danger' onClick={onArm} title={`Delete ${job.id} from ~/.claude/jobs`}>
        Delete
      </button>
    );
  }

  return (
    <span className='job-delete-confirm'>
      <span className='muted'>Delete {fmtBytes(job.bytes)}?</span>
      <button type='button' className='btn-danger armed' disabled={pending} onClick={onConfirm}>
        {pending ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button type='button' className='link' disabled={pending} onClick={onCancel}>
        cancel
      </button>
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={['sortable', className].filter(Boolean).join(' ')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='card stat'>
      <div className='stat-label'>{label}</div>
      <div className='stat-value'>{value}</div>
      <div className='stat-foot'>{sub && <span className='muted'>{sub}</span>}</div>
    </div>
  );
}
