import type { JobTreeNode } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';
import type { JobSummary } from '../api';
import { getJob, getJobFile } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { HeaderHint } from '../components/HeaderHint';
import { JobFileTree } from '../components/JobFileTree';
import { JobFileView } from '../components/JobFileView';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonStats, SkeletonText, SkeletonTextCard } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtLocalTs } from '../format';
import { cwdLabel, StateBadge } from './jobs';

/**
 * One background job: what its `state.json` says, and its directory as a browsable
 * folder tree with a pretty/raw viewer for whatever you open.
 */

/** The first file the tree should open, depth-first: the job's state file if it has
 * one, else whatever file comes first. Directories never auto-open a viewer. */
function firstFile(nodes: readonly JobTreeNode[]): JobTreeNode | null {
  const files: JobTreeNode[] = [];
  const walk = (list: readonly JobTreeNode[]): void => {
    for (const node of list) {
      if (node.dir) walk(node.children);
      else files.push(node);
    }
  };
  walk(nodes);
  return files.find((f) => f.path === 'state.json') ?? files[0] ?? null;
}

export function JobDetailPage() {
  const { id } = useParams({ from: '/jobs/$id' });
  const query = useQuery({ queryKey: ['job', id], queryFn: () => getJob(id) });
  const data = query.data;

  const [picked, setPicked] = useState<string | null>(null);
  const fallback = useMemo(() => firstFile(data?.tree ?? [])?.path ?? null, [data?.tree]);
  const selected = picked ?? fallback;

  const fileQuery = useQuery({
    queryKey: ['job-file', id, selected],
    queryFn: () => getJobFile(id, selected as string),
    enabled: selected !== null,
  });

  const job = data?.job;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/jobs' className='link'>
          Jobs
        </Link>
        <span className='crumb-current'>{job?.name || id}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>{job?.name || id}</h1>
        <div className='muted'>
          <span className='rule-name'>{id}</span>
          {job?.nameSource ? ` · named by ${job.nameSource}` : ''}
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<JobDetailSkeleton />}>
        {!job || !data ? null : (
          <>
            <div className='grid stats'>
              <StatTile
                label='State'
                value={job.state || 'unknown'}
                sub={job.tempo ? `${job.tempo} tempo` : undefined}
              />
              <StatTile label='Files' value={fmtInt(job.files)} sub={fmtBytes(job.bytes)} />
              <StatTile
                label='Started'
                value={job.createdAt ? fmtLocalTs(job.createdAt) : '—'}
                sub={job.cliVersion ? `CLI ${job.cliVersion}` : undefined}
              />
              <StatTile
                label='Last write'
                value={job.updatedAt ? fmtLocalTs(job.updatedAt) : fmtLocalTs(job.modified)}
                sub={job.tokens === null ? undefined : `${fmtInt(job.tokens)} tokens`}
              />
            </div>

            {!job.stateReadable && (
              <div className='card' style={{ marginBottom: 16 }}>
                <div className='leak-note'>
                  <strong>This is a husk.</strong> The directory has no readable{' '}
                  <span className='rule-name'>state.json</span>, so its job is gone and only the files it left behind
                  remain.
                </div>
              </div>
            )}

            <JobFacts job={job} />

            <div className='card'>
              <div className='card-head'>
                <h2>Files</h2>
                <span className='muted'>
                  {data.meta.entries} entr{data.meta.entries === 1 ? 'y' : 'ies'}
                  {data.meta.truncated ? ' · walk stopped early' : ''}
                </span>
              </div>
              {data.meta.truncated && (
                <div className='leak-note' style={{ marginTop: 8 }}>
                  This directory holds more than the walk reports. Dependency directories such as{' '}
                  <span className='rule-name'>node_modules</span> are listed but never descended into.
                </div>
              )}
              <div className='jobfiles'>
                <JobFileTree nodes={data.tree} selected={selected} onSelect={(node) => setPicked(node.path)} />
                <div className='jobfiles-view'>
                  {selected === null ? (
                    <div className='empty'>Pick a file to read it.</div>
                  ) : (
                    <QueryState isLoading={fileQuery.isLoading} error={fileQuery.error} skeleton={<JobFileSkeleton />}>
                      {fileQuery.data && <JobFileView file={fileQuery.data.file} />}
                    </QueryState>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The page down to the file browser, including both sides of the `.jobfiles` split. */
function JobDetailSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <SkeletonTextCard title='Job' lines={5} />
      <div className='card'>
        <div className='card-head'>
          <h2>Files</h2>
          <Skeleton w='20%' />
        </div>
        <div className='jobfiles'>
          <div className='jobtree' aria-hidden>
            <SkeletonText lines={9} />
          </div>
          <div className='jobfiles-view'>
            <JobFileSkeleton />
          </div>
        </div>
      </div>
    </>
  );
}

/** `JobFileView`'s own frame: its head row, then the document it is about to show. */
function JobFileSkeleton() {
  return (
    <div className='jobview' aria-hidden>
      <div className='jobview-head'>
        <div className='jobview-title'>
          <Skeleton w='14rem' />
        </div>
        <Skeleton w='7rem' />
      </div>
      <SkeletonText lines={10} />
    </div>
  );
}

/** The state file's own fields, as a definition grid plus the links and tasks it carries. */
function JobFacts({ job }: { job: JobSummary }) {
  const rows = [
    { key: 'state', value: job.state },
    { key: 'detail', value: job.detail },
    { key: 'ran in', value: job.cwd },
    { key: 'agent', value: job.agent },
    { key: 'model', value: job.model },
    { key: 'template', value: job.template },
    { key: 'backend', value: job.backend },
    { key: 'session id', value: job.sessionId },
    { key: 'first finished', value: job.firstTerminalAt ? fmtLocalTs(job.firstTerminalAt) : '' },
  ].filter((r) => r.value !== '');

  return (
    <>
      <div className='card' style={{ marginBottom: 16 }}>
        <div className='card-head'>
          <h2>Job</h2>
          <StateBadge state={job.state} />
        </div>
        {job.intent !== '' && (
          <>
            <div className='stat-label' style={{ marginTop: 12 }}>
              What it was asked to do
            </div>
            <div className='msg-text job-intent'>{job.intent}</div>
          </>
        )}
        {rows.length > 0 && (
          <dl className='fm' style={{ marginTop: 16, marginBottom: 0 }}>
            {rows.map((r) => (
              <Fragment key={r.key}>
                <dt>{r.key}</dt>
                <dd className={r.key === 'ran in' || r.key === 'session id' ? 'mono-break' : undefined}>
                  {r.key === 'ran in' ? `${cwdLabel(r.value)} — ${r.value}` : r.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>

      {job.children.length > 0 && (
        <div className='card' style={{ marginBottom: 16 }}>
          <div className='card-head'>
            <h2>What it produced</h2>
            <span className='muted'>links the job recorded</span>
          </div>
          <table className='table' style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>
                  Kind
                  <HeaderHint text="What the artifact links to, as the job's state file recorded it — pr, issue, branch. Reads “link” when the file named no kind." />
                </th>
                <th>
                  Id
                  <HeaderHint text="The artifact's identifier from the same record, or — when the file carried none." />
                </th>
                <th>
                  Link
                  <HeaderHint text='The URL the job wrote down. It opens in a new tab and is not checked from here.' />
                </th>
              </tr>
            </thead>
            <tbody>
              {job.children.map((child) => (
                <tr key={`${child.kind}-${child.id}-${child.href}`}>
                  <td>
                    <span className='badge neutral'>{child.kind || 'link'}</span>
                  </td>
                  <td className='rule-name'>{child.id || '—'}</td>
                  <td>
                    <a className='link mono-break' href={child.href} target='_blank' rel='noreferrer'>
                      {child.href}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {job.fan.length > 0 && (
        <div className='card' style={{ marginBottom: 16 }}>
          <div className='card-head'>
            <h2>In flight at the last write</h2>
            <span className='muted'>
              {job.inFlight
                ? `${job.inFlight.tasks} task${job.inFlight.tasks === 1 ? '' : 's'}, ${job.inFlight.queued} queued`
                : `${job.fan.length} task${job.fan.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className='leak-note' style={{ marginTop: 8 }}>
            A snapshot, not a live list — the state file records what was running when it was last written.
          </div>
          <table className='table' style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>
                  Kind
                  <HeaderHint text='Whatever the job called the task — shell, local_bash, an agent name. Reads “task” when the file named no kind.' />
                </th>
                <th>
                  Started
                  <HeaderHint text='When the task began, in local time, converted from the epoch milliseconds the state file stores. Reads — when it stored none.' />
                </th>
                <th>
                  What
                  <HeaderHint text="The task's label as the job wrote it, not a description generated here." />
                </th>
              </tr>
            </thead>
            <tbody>
              {job.fan.map((task) => (
                <tr key={task.id || task.label}>
                  <td>
                    <span className='badge neutral'>{task.kind || 'task'}</span>
                  </td>
                  <td className='num muted'>{task.startedAt ? fmtLocalTs(task.startedAt) : '—'}</td>
                  <td>
                    <span className='rule-name job-fan-label'>{task.label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
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
