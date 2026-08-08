import type { PrBranch, PrSessionLink, PullRequestRow, PullRequestState } from '@claude-proxy/core';
import { buildPrTree, prCounts } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { getPullRequests } from '../api';
import { Skeleton, SkeletonStatus } from '../components/Skeleton';
import { fmtInt, fmtLocalTsShort } from '../format';

/**
 * The project's pull requests as the tree they actually formed: merged PRs form the
 * spine, newest at the top, and everything that did not land hangs off the merge it
 * was cut from. Clicking a node opens the live session graph's detail drawer, down to
 * that drawer's own classes.
 *
 * Read-only, and polls.
 */

/** How often the page re-asks. */
const REFETCH_MS = 30_000;

const STATE_COLOR: Record<PullRequestState | 'draft', string> = {
  open: 'var(--good)',
  merged: 'var(--violet)',
  closed: 'var(--coral)',
  draft: 'var(--muted)',
};

/** Draft is a shade of open, not a fourth state — it only changes how a PR is drawn. */
const toneOf = (pr: PullRequestRow): PullRequestState | 'draft' => (pr.isDraft ? 'draft' : pr.state);

/** The timestamp that says when a PR reached the state it is in now. */
const stampOf = (pr: PullRequestRow): string => pr.mergedAt ?? pr.closedAt ?? pr.updatedAt ?? pr.createdAt;

export function PullRequestsPage() {
  const query = useQuery({ queryKey: ['pull-requests'], queryFn: getPullRequests, refetchInterval: REFETCH_MS });
  const rows = query.data?.prs ?? [];
  const sessions = query.data?.sessions ?? {};
  const tree = buildPrTree(rows);
  const counts = prCounts(rows);

  const [selected, setSelected] = useState<PullRequestRow | null>(null);
  const [wide, setWide] = useState(false);

  // Esc closes the drawer, as on the session graph.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  /** Trunk index → the PRs cut from it that never landed, newest opened first. */
  const hanging = (after: number): PrBranch[] =>
    [...tree.open, ...tree.closed]
      .filter((b) => b.after === after)
      .sort((a, b) => b.pr.createdAt.localeCompare(a.pr.createdAt));

  const node = (pr: PullRequestRow, cls: string) => (
    <PrNode
      key={pr.number}
      pr={pr}
      className={cls}
      sessions={sessions[pr.number]?.length ?? 0}
      selected={selected?.number === pr.number}
      onSelect={() => setSelected(pr)}
    />
  );

  return (
    <section className='pr-page'>
      <header className='pr-head'>
        <div>
          <h1>Pull requests</h1>
          <p className='muted'>
            {query.data?.repo ?? 'this repository'} — merged PRs form the trunk, newest first; open and closed ones hang
            off the merge they were cut from.
          </p>
        </div>
        <div className='pr-counts'>
          <Count label='open' value={counts.open} tone='open' />
          <Count label='merged' value={counts.merged} tone='merged' />
          <Count label='closed' value={counts.closed} tone='closed' />
          {counts.draft > 0 ? <Count label='draft' value={counts.draft} tone='draft' /> : null}
        </div>
      </header>

      {query.data?.error ? <p className='pr-error'>{query.data.error}</p> : null}
      {query.isLoading ? <SkeletonStatus label='Reading pull requests from GitHub' /> : null}

      <div className='pr-viewport'>
        {query.isLoading ? (
          <div className='pr-tree'>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} h={64} />
            ))}
          </div>
        ) : rows.length === 0 && !query.data?.error ? (
          <p className='muted pr-empty'>No pull requests yet.</p>
        ) : (
          <ol className='pr-tree'>
            {/* Newest merge first, each followed by whatever was cut from it. */}
            {tree.trunk
              .map((pr, i) => ({ pr, i }))
              .reverse()
              .map(({ pr, i }) => (
                <li key={pr.number} className='pr-row'>
                  {node(pr, 'pr-node pr-node--trunk')}
                  {hanging(i).map((b) => node(b.pr, 'pr-node pr-node--branch'))}
                </li>
              ))}
            {/* Cut before anything had merged, so they hang off the root rather than a trunk point. */}
            {hanging(-1).length > 0 ? (
              <li className='pr-row'>
                <div className='pr-root'>before the first merge</div>
                {hanging(-1).map((b) => node(b.pr, 'pr-node pr-node--branch'))}
              </li>
            ) : null}
          </ol>
        )}

        {selected ? (
          <PrInspector
            key={selected.number}
            pr={selected}
            sessions={sessions[selected.number] ?? []}
            wide={wide}
            onToggleWide={() => setWide((w) => !w)}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>

      {query.data ? (
        <p className='pr-note muted'>
          Read through the GitHub CLI, refreshed every {REFETCH_MS / 1000}s · last read{' '}
          {fmtLocalTsShort(query.data.meta.fetchedAt)}
          {query.data.meta.cached ? ' (cached)' : ''}
        </p>
      ) : null}
    </section>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: PullRequestState | 'draft' }) {
  return (
    <span className='pr-count' style={{ '--gc': STATE_COLOR[tone] } as CSSProperties}>
      <b>{fmtInt(value)}</b> {label}
    </span>
  );
}

/** One PR on the tree; the whole box is the hit target. */
function PrNode({
  pr,
  className,
  sessions,
  selected,
  onSelect,
}: {
  pr: PullRequestRow;
  className: string;
  sessions: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = toneOf(pr);
  return (
    <button
      type='button'
      className={`${className}${selected ? ' is-selected' : ''}`}
      style={{ '--gc': STATE_COLOR[tone] } as CSSProperties}
      onClick={onSelect}>
      <span className='pr-node-kind'>{tone}</span>
      <span className='pr-node-title'>
        <span className='pr-node-num'>#{pr.number}</span> {pr.title || '(no title)'}
      </span>
      <span className='pr-node-sub'>
        {pr.author || 'unknown'} · {fmtLocalTsShort(stampOf(pr))}
        {sessions > 0 ? ` · ${fmtInt(sessions)} session${sessions === 1 ? '' : 's'}` : ''}
      </span>
    </button>
  );
}

/** The detail drawer, sharing the session graph's inspector classes and behaviour. */
function PrInspector({
  pr,
  sessions,
  wide,
  onToggleWide,
  onClose,
}: {
  pr: PullRequestRow;
  sessions: PrSessionLink[];
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
}) {
  const tone = toneOf(pr);
  return (
    <aside className={`graph-inspector${wide ? ' is-wide' : ''}`} aria-label='Pull request details'>
      <div className='gi-head'>
        <span className='gi-kind' style={{ '--gc': STATE_COLOR[tone] } as CSSProperties}>
          {tone}
        </span>
        <div className='gi-actions'>
          <button
            type='button'
            className='gi-wide'
            onClick={onToggleWide}
            aria-expanded={wide}
            title={wide ? 'Narrow the drawer' : 'Widen the drawer'}>
            {wide ? '⇥' : '⇤'}
          </button>
          <button type='button' className='gi-close' onClick={onClose} aria-label='Close'>
            ×
          </button>
        </div>
      </div>

      <div className='gi-body'>
        <Field label={`#${pr.number}`}>{pr.title || '(no title)'}</Field>
        <Field label='Author'>{pr.author || '—'}</Field>
        <Field label='Branch'>
          <span className='mono-break'>
            {pr.headRefName || '—'} → {pr.baseRefName || '—'}
          </span>
        </Field>
        {pr.labels.length > 0 ? <Field label='Labels'>{pr.labels.join(', ')}</Field> : null}
        <Field label='Opened'>{fmtLocalTsShort(pr.createdAt)}</Field>
        {pr.mergedAt ? <Field label='Merged'>{fmtLocalTsShort(pr.mergedAt)}</Field> : null}
        {pr.closedAt && !pr.mergedAt ? <Field label='Closed'>{fmtLocalTsShort(pr.closedAt)}</Field> : null}
        {!pr.closedAt ? <Field label='Updated'>{fmtLocalTsShort(pr.updatedAt)}</Field> : null}
        <div className='gi-stats'>
          <Stat label='files' value={pr.changedFiles} />
          <Stat label='added' value={pr.additions} />
          <Stat label='removed' value={pr.deletions} />
        </div>
        {pr.body.trim() ? (
          <Field label='Description'>
            <LongText text={pr.body} />
          </Field>
        ) : null}

        <Field label='Sessions'>
          {sessions.length === 0 ? (
            <span className='muted'>No transcript on record mentions this PR.</span>
          ) : (
            <ul className='pr-sessions'>
              {sessions.map((s) => (
                <li key={s.threadId}>
                  <Link to='/sessions/$id' params={{ id: s.threadId }} className='link'>
                    {s.title}
                  </Link>
                  <span className='muted'>
                    {' '}
                    · matched by {s.via.join(' + ')} · {fmtLocalTsShort(s.modified)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <span className='gi-note muted'>
          Sessions are recovered from the transcripts kept on this device, which hold roughly today only.
        </span>

        {pr.url ? (
          <a href={pr.url} target='_blank' rel='noreferrer' className='link gi-open'>
            Open on GitHub →
          </a>
        ) : null}
      </div>
    </aside>
  );
}

/** Past this much text a description is folded away until asked for. */
const LONG_TEXT_CHARS = 280;

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT_CHARS;
  const cls = `gi-text${long ? (open ? ' is-full' : ' is-clamped') : ''}`;
  return (
    <>
      <p className={cls}>{text}</p>
      {long ? (
        <button type='button' className='link gi-more' onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Show less' : `Show all ${fmtInt(text.length)} characters`}
        </button>
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='gi-field'>
      <span className='gi-label'>{label}</span>
      <div className='gi-value'>{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className='gi-stat'>
      <span className='gi-stat-value'>{fmtInt(value)}</span>
      <span className='gi-stat-label'>{label}</span>
    </div>
  );
}
