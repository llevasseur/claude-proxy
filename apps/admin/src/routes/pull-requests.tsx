import type { MainHistoryRow, PrBranch, PrSessionLink, PullRequestRow, PullRequestState } from '@claude-proxy/core';
import { buildPrTree, prCounts, shortSha } from '@claude-proxy/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { LocalDivergence } from '../api';
import { getPullRequests, setMainLineHidden, slideMain, syncLocalMain } from '../api';
import { Skeleton, SkeletonStatus } from '../components/Skeleton';
import { fmtInt, fmtLocalTsShort } from '../format';

/**
 * The project's pull requests as the tree they actually formed: merged PRs form the
 * spine, newest at the top, and everything that did not land hangs off the merge it
 * was cut from. Clicking a node opens the live session graph's detail drawer, down to
 * that drawer's own classes.
 *
 * It is also where `main` is moved. A merged PR's landing commit is a position `main`
 * can be slid to, forwards or back; the commits it slides off are not destroyed but kept
 * alive by a pin and drawn in their own lane beside the rail. The rail runs straight up
 * past the top of the list, because `main` is the one line that keeps going.
 */

/** How often the page re-asks. */
const REFETCH_MS = 30_000;

const PULL_REQUESTS_KEY = ['pull-requests'];

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
  const client = useQueryClient();
  const query = useQuery({ queryKey: PULL_REQUESTS_KEY, queryFn: getPullRequests, refetchInterval: REFETCH_MS });
  const rows = query.data?.prs ?? [];
  const sessions = query.data?.sessions ?? {};
  const tree = buildPrTree(rows);
  const counts = prCounts(rows);

  const history = query.data?.mainHistory;
  const rowByPr = new Map((history?.rows ?? []).map((r) => [r.prNumber, r]));

  const [selected, setSelected] = useState<PullRequestRow | null>(null);
  const [wide, setWide] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  // Every write here changes what the rail looks like, so all three end the same way.
  const refresh = () => {
    void client.invalidateQueries({ queryKey: PULL_REQUESTS_KEY });
  };
  const slide = useMutation({
    mutationFn: ({ expectedMain, target }: { expectedMain: string; target: string }) => slideMain(expectedMain, target),
    onSuccess: refresh,
  });
  const hide = useMutation({
    mutationFn: ({ sha, hidden }: { sha: string; hidden: boolean }) => setMainLineHidden(sha, hidden),
    onSuccess: refresh,
  });
  const sync = useMutation({ mutationFn: (preserve: boolean) => syncLocalMain(preserve), onSuccess: refresh });

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
      row={rowByPr.get(pr.number) ?? null}
      sessions={sessions[pr.number]?.length ?? 0}
      selected={selected?.number === pr.number}
      onSelect={() => setSelected(pr)}
    />
  );

  /**
   * The trunk in drawing order, newest merge first, with hidden lines folded away.
   *
   * A hidden trunk point still had PRs cut from it, so those move down onto the next row
   * that is drawn rather than disappearing with the line they hung off.
   */
  const trunkRows: Array<{ pr: PullRequestRow; i: number; extra: PrBranch[] }> = [];
  let carried: PrBranch[] = [];
  for (const { pr, i } of tree.trunk.map((pr, i) => ({ pr, i })).reverse()) {
    if (rowByPr.get(pr.number)?.hidden && !showHidden) {
      carried = [...carried, ...hanging(i)];
      continue;
    }
    trunkRows.push({ pr, i, extra: carried });
    carried = [];
  }
  const hiddenCount = history?.rows.filter((r) => r.hidden).length ?? 0;
  const rootBranches = [...carried, ...hanging(-1)];

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

      {history ? (
        <div className='pr-main-bar'>
          <span className='pr-main-at'>
            <span className='pr-main-chip'>main</span>
            {history.mainSha ? (
              <>
                <code className='mono'>{shortSha(history.mainSha)}</code>
                {history.mainPr !== null ? <span className='muted'> · landed by #{history.mainPr}</span> : null}
              </>
            ) : (
              <span className='muted'>not read yet</span>
            )}
          </span>
          {hiddenCount > 0 ? (
            <button type='button' className='link' onClick={() => setShowHidden((s) => !s)} aria-pressed={showHidden}>
              {showHidden ? 'Fold hidden lines away' : `Show ${fmtInt(hiddenCount)} hidden`}
            </button>
          ) : null}
        </div>
      ) : null}

      {query.data?.localMain ? (
        <LocalMainBanner
          local={query.data.localMain}
          pending={sync.isPending}
          error={sync.error ? String(sync.error.message) : null}
          result={sync.data ?? null}
          onSync={(preserve) => sync.mutate(preserve)}
        />
      ) : null}

      {query.data?.error ? <p className='pr-error'>{query.data.error}</p> : null}
      {query.data?.refError ? (
        <p className='pr-error'>could not refresh main and its pins — {query.data.refError}</p>
      ) : null}
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
          <ol className='pr-tree' style={{ '--pr-lanes': history?.width ?? 1 } as CSSProperties}>
            {/* Newest merge first, each followed by whatever was cut from it. */}
            {trunkRows.map(({ pr, i, extra }, k) => {
              const row = rowByPr.get(pr.number) ?? null;
              const lane = row?.lane ?? 0;
              // Older commits are further down, so a lane's *last* row is where it forks
              // off the rail — that is the one row that kinks, and it kinks exactly once.
              const nextPr = trunkRows[k + 1]?.pr.number;
              const forks = lane > 0 && (nextPr === undefined || (rowByPr.get(nextPr)?.lane ?? 0) !== lane);
              return (
                <li
                  key={pr.number}
                  className={`pr-row${lane > 0 ? ' pr-row--off-main' : ''}${forks ? ' is-lane-base' : ''}${
                    row?.isMain ? ' is-main' : ''
                  }${row?.hidden ? ' is-hidden-line' : ''}`}
                  style={{ '--pr-lane': Math.max(lane, 0) } as CSSProperties}>
                  {node(pr, 'pr-node pr-node--trunk')}
                  {[...extra, ...hanging(i)].map((b) => node(b.pr, 'pr-node pr-node--branch'))}
                </li>
              );
            })}
            {/* Cut before anything had merged, so they hang off the root rather than a trunk point. */}
            {rootBranches.length > 0 ? (
              <li className='pr-row'>
                <div className='pr-root'>before the first merge</div>
                {rootBranches.map((b) => node(b.pr, 'pr-node pr-node--branch'))}
              </li>
            ) : null}
          </ol>
        )}

        {selected ? (
          <PrInspector
            key={selected.number}
            pr={selected}
            sessions={sessions[selected.number] ?? []}
            row={rowByPr.get(selected.number) ?? null}
            mainSha={history?.mainSha ?? ''}
            slidePending={slide.isPending}
            slideError={slide.error ? String(slide.error.message) : null}
            hidePending={hide.isPending}
            onSlide={(target) => slide.mutate({ expectedMain: history?.mainSha ?? '', target })}
            onHide={(sha, hidden) => hide.mutate({ sha, hidden })}
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
  row,
  sessions,
  selected,
  onSelect,
}: {
  pr: PullRequestRow;
  className: string;
  /** Where this PR's landing commit sits relative to `main`, when it has one. */
  row: MainHistoryRow | null;
  sessions: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = toneOf(pr);
  return (
    <button
      type='button'
      className={`${className}${selected ? ' is-selected' : ''}${row?.isMain ? ' is-main' : ''}`}
      style={{ '--gc': STATE_COLOR[tone] } as CSSProperties}
      onClick={onSelect}>
      {row?.isMain ? <span className='pr-main-marker'>main →</span> : null}
      <span className='pr-node-kind'>{tone}</span>
      <span className='pr-node-title'>
        <span className='pr-node-num'>#{pr.number}</span> {pr.title || '(no title)'}
      </span>
      <span className='pr-node-sub'>
        {pr.author || 'unknown'} · {fmtLocalTsShort(stampOf(pr))}
        {sessions > 0 ? ` · ${fmtInt(sessions)} session${sessions === 1 ? '' : 's'}` : ''}
        {row && !row.onMain ? ` · off main${row.hidden ? ', hidden' : ''}` : ''}
      </span>
    </button>
  );
}

/**
 * What `git pull` will not tell you: this checkout's own `main` no longer matches
 * `origin/main`. Sliding `main` back leaves the local branch on a *descendant*, so pull
 * reports "Already up to date" and quietly keeps the newer commit.
 *
 * Every reason a sync would refuse is computed before the button is drawn, so pressing it
 * is never the first time a blocker is discovered.
 */
function LocalMainBanner({
  local,
  pending,
  error,
  result,
  onSync,
}: {
  local: LocalDivergence;
  pending: boolean;
  error: string | null;
  result: {
    plan: string;
    stashSha: string | null;
    recorded: string;
    preservedAt: string | null;
    note: string | null;
  } | null;
  onSync: (preserve: boolean) => void;
}) {
  if (!local.diverged && !result && !error) return null;

  const hard = local.blockers.filter((b) => b.reason !== 'unpushed-commits');
  return (
    <div className='pr-local'>
      {local.diverged ? (
        <p className='pr-local-line'>
          This checkout's <code className='mono'>main</code> is at{' '}
          <code className='mono'>{shortSha(local.localMain ?? '')}</code>, origin is at{' '}
          <code className='mono'>{shortSha(local.originMain ?? '')}</code>
          {local.behind ? ' — a plain `git pull` will not move it back.' : '.'}
        </p>
      ) : null}

      {hard.map((b) => (
        <p key={b.reason + b.detail} className='pr-local-block'>
          Cannot sync: {b.detail}.
        </p>
      ))}

      {local.diverged && hard.length === 0 ? (
        <div className='pr-local-act'>
          <button type='button' className='btn-save' disabled={pending} onClick={() => onSync(local.preservable)}>
            {pending
              ? 'Syncing…'
              : local.plan === 'stash-reset'
                ? 'Stash and point main at origin'
                : 'Point main at origin'}
          </button>
          {local.preservable ? (
            <span className='muted'>
              {fmtInt(local.unreferenced.length)} local commit
              {local.unreferenced.length === 1 ? '' : 's'} nothing else reaches — they will be saved to a ref first.
            </span>
          ) : local.plan === 'stash-reset' ? (
            <span className='muted'>main is checked out, so work in progress is stashed before the reset.</span>
          ) : (
            <span className='muted'>HEAD is elsewhere, so only the branch pointer moves.</span>
          )}
        </div>
      ) : null}

      {error ? <p className='pr-error'>{error}</p> : null}
      {result ? (
        <p className='pr-local-done'>
          Synced ({result.plan}). Previous position recorded in this checkout at{' '}
          <code className='mono'>{result.recorded}</code> (a local ref, not pushed to origin)
          {result.stashSha ? (
            <>
              {' '}
              · stash <code className='mono'>{shortSha(result.stashSha)}</code>
            </>
          ) : null}
          {result.preservedAt ? (
            <>
              {' '}
              · unpushed work saved at <code className='mono'>{result.preservedAt}</code>
            </>
          ) : null}
          {result.note ? ` · ${result.note}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The drawer's half of moving `main`: one button, then a confirmation that names both
 * commits, because the thing being changed is shared and the page may have gone stale.
 */
function SlideControls({
  pr,
  row,
  mainSha,
  pending,
  error,
  hidePending,
  onSlide,
  onHide,
}: {
  pr: PullRequestRow;
  row: MainHistoryRow;
  mainSha: string;
  pending: boolean;
  error: string | null;
  hidePending: boolean;
  onSlide: (target: string) => void;
  onHide: (sha: string, hidden: boolean) => void;
}) {
  const [armed, setArmed] = useState(false);
  const isMain = row.isMain;

  return (
    <Field label='main'>
      <div className='pr-slide'>
        <span className='mono-break'>{shortSha(row.sha)}</span>
        <span className='muted'>
          {isMain
            ? ' — main is here'
            : row.onMain
              ? ' — behind main'
              : row.hidden
                ? ' — off main, on a hidden line'
                : ' — off main, kept by a pin'}
        </span>

        {armed && !isMain ? (
          <div className='pr-slide-confirm'>
            <p>
              Move <code className='mono'>main</code> from <code className='mono'>{shortSha(mainSha)}</code> to{' '}
              <code className='mono'>{shortSha(row.sha)}</code> (#{pr.number})? Nothing is destroyed — the commit main
              leaves is pinned first.
            </p>
            <div className='pr-slide-act'>
              <button
                type='button'
                className='btn-save'
                disabled={pending || !mainSha}
                onClick={() => {
                  onSlide(row.sha);
                  setArmed(false);
                }}>
                {pending ? 'Moving…' : 'Move main'}
              </button>
              <button type='button' className='link' onClick={() => setArmed(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type='button' className='btn-save' disabled={isMain || pending} onClick={() => setArmed(true)}>
            {isMain ? 'main is here' : 'Set main here'}
          </button>
        )}

        {!row.onMain ? (
          <button type='button' className='link' disabled={hidePending} onClick={() => onHide(row.sha, !row.hidden)}>
            {row.hidden ? 'Show this line' : 'Hide this line'}
          </button>
        ) : null}
        {row.pins.length > 0 ? <span className='gi-note muted'>pinned by {row.pins.join(', ')}</span> : null}
        {error ? <p className='pr-error'>{error}</p> : null}
      </div>
    </Field>
  );
}

/** The detail drawer, sharing the session graph's inspector classes and behaviour. */
function PrInspector({
  pr,
  sessions,
  row,
  mainSha,
  slidePending,
  slideError,
  hidePending,
  onSlide,
  onHide,
  wide,
  onToggleWide,
  onClose,
}: {
  pr: PullRequestRow;
  sessions: PrSessionLink[];
  /** Null for a PR that never landed — there is no position to move `main` to. */
  row: MainHistoryRow | null;
  mainSha: string;
  slidePending: boolean;
  slideError: string | null;
  hidePending: boolean;
  onSlide: (target: string) => void;
  onHide: (sha: string, hidden: boolean) => void;
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
        {row ? (
          <SlideControls
            pr={pr}
            row={row}
            mainSha={mainSha}
            pending={slidePending}
            error={slideError}
            hidePending={hidePending}
            onSlide={onSlide}
            onHide={onHide}
          />
        ) : null}
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
