import { type IdeaEntry, ideaAreaLabel, ideaTaskPrompt, SEED_IDEA_AREAS } from '@claude-proxy/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { commentIdeas, fileIdeas, getIdeas, type IdeasResponse } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import {
  hasIdeaDecision,
  IDEA_STATUS_LABEL,
  IDEAS_KEY,
  IdeaDecisionControls,
  IdeaEvidenceList,
  IdeaKey,
} from '../components/IdeaCard';
import { LiveIndicator } from '../components/LiveIndicator';
import { Markdown } from '../components/Markdown';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { fmtLocalTsShort } from '../format';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';

/**
 * One idea, in full.
 *
 * **The area is deliberately absent from the permalink** — `/ideas/$slug`, never
 * `/ideas/$area/$slug` — so correcting a misfile cannot break a link. The slug is
 * the ledger's own key, so it is the address.
 *
 * There is no per-idea endpoint: the ledger is small, the list is already cached
 * under the same query key, and one shape means a write from either page moves
 * both.
 */
export function IdeaDetailPage() {
  const { slug } = useParams({ from: '/ideas/$slug' });
  const query = useQuery({ queryKey: [IDEAS_KEY], queryFn: getIdeas });
  const live = useLiveQuery<IdeasResponse>('/api/ideas/stream', [IDEAS_KEY]);
  const idea = query.data?.rows.find((row) => row.slug === slug);
  // Every area anyone has used, seeds included — not just the five seeds.
  const known = [
    ...SEED_IDEA_AREAS.map((s) => s.area),
    ...(query.data?.meta.areas.areas ? Object.keys(query.data.meta.areas.areas) : []),
  ];
  const areas = [...new Set(known)];

  return (
    <section>
      <Breadcrumbs>
        <Link to='/ideas' className='link'>
          Ideas
        </Link>
        <span className='crumb-current'>{idea?.title ?? slug}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        {/* The head is space-between, so the key needs to travel with the title
            rather than sit as a sibling that would be flung to the far edge. */}
        <div className='pagehead-title idea-titled'>
          <h1>{idea?.title ?? 'Idea'}</h1>
          <IdeaKey slug={slug} />
        </div>
        <LiveIndicator status={live} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<IdeaSkeleton />}>
        {idea ? (
          <IdeaBody idea={idea} areas={areas} />
        ) : (
          query.data && (
            <div className='card empty'>
              No idea on the ledger under <code>{slug}</code>.
            </div>
          )
        )}
      </QueryState>
    </section>
  );
}

function IdeaBody({ idea, areas }: { idea: IdeaEntry; areas: string[] }) {
  return (
    <>
      <div className='card'>
        <div className='card-head'>
          <h2>Rationale</h2>
          <span className={`badge idea-status-${idea.status}`}>{IDEA_STATUS_LABEL[idea.status]}</span>
          <span className={`badge idea-area${idea.area ? '' : ' idea-area-unfiled'}`}>{ideaAreaLabel(idea.area)}</span>
          <code className='idea-repo muted'>{idea.repo}</code>
        </div>
        {/* Markdown, not the card's preview: the card's clamp needs a `-webkit-box`,
            which unmakes a list. */}
        <div className='idea-rationale-md'>
          <Markdown source={idea.rationale} />
        </div>
        <div className='muted idea-when'>
          proposed {fmtLocalTsShort(idea.created)}
          {idea.updated && idea.updated !== idea.created ? ` · updated ${fmtLocalTsShort(idea.updated)}` : ''}
          {/* The provenance envelope: which session's thread decided this. A row
              written before it existed carries none and says nothing here. */}
          {idea.by && <> · by {idea.by.thread}</>}
        </div>
        {idea.note && (
          <div className='suggestion-note'>
            {idea.status === 'shipped' ? 'shipped: ' : idea.status === 'rejected' ? 'reason: ' : 'note: '}
            {idea.note}
          </div>
        )}
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Evidence</h2>
          <span className='muted'>what makes it approvable — every citation, with its quote</span>
        </div>
        {idea.evidence.length === 0 ? (
          <div className='muted'>Nothing cited.</div>
        ) : (
          <IdeaEvidenceList evidence={idea.evidence} />
        )}
      </div>

      {idea.claim && (
        <div className='card'>
          <div className='card-head'>
            <h2>Claim</h2>
          </div>
          <div className='suggestion-note idea-claim'>
            held by <strong>{idea.claim.by}</strong> since {fmtLocalTsShort(idea.claim.at)} ({claimAge(idea.claim.at)})
            {idea.claim.pr && (
              <>
                {' — '}
                <a className='link mono-break' href={idea.claim.pr} target='_blank' rel='noreferrer'>
                  {idea.claim.pr}
                </a>
              </>
            )}
          </div>
        </div>
      )}

      {/* Decision — the same controls the card carries, so the rationale can be acted on here.
          Absent where the controls have no move to offer, rather than a heading over an empty row. */}
      {hasIdeaDecision(idea.status) && (
        <div className='card'>
          <div className='card-head'>
            <h2>Decision</h2>
            <span className='muted'>the same sign-off the card carries — a rejection still needs its reason</span>
          </div>
          <IdeaDecisionControls idea={idea} />
        </div>
      )}

      {/* Keyed by slug: these three hold reader-edited drafts, and the route
          re-renders rather than remounting when one permalink links to another. */}
      <TaskPromptCard key={idea.slug} idea={idea} />
      <AreaPicker key={idea.slug} idea={idea} areas={areas} />
      <CommentEditor key={idea.slug} idea={idea} />
    </>
  );
}

/** The clipboard glyph, inline so the button carries no icon dependency. */
function CopyGlyph() {
  return (
    <svg
      viewBox='0 0 16 16'
      width='14'
      height='14'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.3'
      aria-hidden='true'>
      <rect x='5.5' y='5.5' width='8' height='9' rx='1.5' />
      <path d='M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1' />
    </svg>
  );
}

/**
 * The `/task` prompt that builds this idea, ready to paste into an agent.
 *
 * **One editable field, not a preview beside it.** The textarea reads the
 * prompt and takes a caveat that belongs in *this* copy of it, not on the
 * ledger.
 *
 * **The edit is local to the clipboard and deliberately not persisted.** A
 * durable instruction goes in {@link IdeaEntry.comment}, which the generated
 * prompt quotes — storing a second freely-edited copy beside it would give one
 * idea two disagreeing statements of its task. An edit here changes what you
 * copy now; the comment editor below changes what everyone generates next,
 * including `ideas prompt --slug <slug>`.
 */
function TaskPromptCard({ idea }: { idea: IdeaEntry }) {
  const generated = ideaTaskPrompt(idea);
  // The generated prompt this draft was taken from. The page is live over SSE, so
  // the draft follows a regenerated prompt — unless it was edited, since
  // discarding an edit to track a change the reader did not make is worse.
  const [base, setBase] = useState(generated);
  const [draft, setDraft] = useState(generated);
  if (base !== generated) {
    setBase(generated);
    if (draft === base) setDraft(generated);
  }

  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      // Absent outside a secure context, which is exactly where somebody hits it
      // over plain HTTP on another machine — say so rather than failing silently.
      if (!navigator.clipboard) throw new Error('the clipboard needs a secure context (https or localhost)');
      await navigator.clipboard.writeText(draft);
      setCopyError('');
      setCopied(true);
    } catch (err) {
      setCopyError((err as Error).message);
    }
  };

  const edited = draft !== generated;

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Task prompt</h2>
        <span className='muted'>
          derived from this entry — paste it into an agent, or read it with{' '}
          <span className='rule-name'>ideas prompt</span>
        </span>
        {edited && <span className='muted idea-prompt-edited'>edited — this copy only</span>}
        <button type='button' className='btn-quiet idea-prompt-copy' onClick={copy} aria-label='Copy the task prompt'>
          <CopyGlyph />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className='idea-prompt-edit'>
        <textarea value={draft} rows={16} aria-label='Task prompt' onChange={(e) => setDraft(e.target.value)} />
        <div className='idea-controls'>
          <button type='button' className='btn-quiet' disabled={!edited} onClick={() => setDraft(generated)}>
            Reset
          </button>
          <span className='muted'>
            a lasting instruction belongs in the comment below, which every generated prompt quotes
          </span>
        </div>
      </div>

      {copyError && <div className='suggestion-mark-error'>{copyError}</div>}
    </div>
  );
}

/** How long a claim has been held, which is the answer to "why has nothing happened". */
function claimAge(at: string): string {
  const started = new Date(at).getTime();
  if (Number.isNaN(started)) return 'unknown age';
  const hours = (Date.now() - started) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Re-file the idea. Its own control and its own route, never a side effect of a
 * status change.
 */
function AreaPicker({ idea, areas }: { idea: IdeaEntry; areas: string[] }) {
  const client = useQueryClient();
  const [area, setArea] = useState(idea.area ?? '');
  const file = useMutation({
    mutationFn: (next: string) => fileIdeas([{ slug: idea.slug, area: next }]),
    onSuccess: () => client.invalidateQueries({ queryKey: [IDEAS_KEY] }),
  });

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Area</h2>
        <span className='muted'>filing is separate from deciding, so neither moves the other</span>
      </div>
      <form
        className='idea-file'
        onSubmit={(e) => {
          e.preventDefault();
          if (area && area !== idea.area) file.mutate(area);
        }}>
        {/* The wrapper is what draws the disclosure arrow — see `.select-field`. */}
        <div className='select-field'>
          <select value={area} onChange={(e) => setArea(e.target.value)} aria-label='Area'>
            {!idea.area && <option value=''>Unfiled</option>}
            {areas.map((a) => (
              <option key={a} value={a}>
                {ideaAreaLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <button type='submit' className='btn-primary' disabled={!area || area === idea.area || file.isPending}>
          Re-file
        </button>
      </form>
      {/* The server refuses moving a `command-gap` citation out of Commands. */}
      {file.error && <div className='suggestion-mark-error'>{(file.error as Error).message}</div>}
    </div>
  );
}

/**
 * The comment — a person's own words about the proposal, and **not** `note`, which
 * stays the rejection reason or the shipped PR url. Each save replaces the
 * previous comment rather than appending to it.
 */
function CommentEditor({ idea }: { idea: IdeaEntry }) {
  const client = useQueryClient();
  const [text, setText] = useState(idea.comment ?? '');
  const save = useMutation({
    mutationFn: (next: string) => commentIdeas([{ slug: idea.slug, text: next }]),
    onSuccess: () => client.invalidateQueries({ queryKey: [IDEAS_KEY] }),
  });

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Comment</h2>
        <span className='muted'>
          build criteria for <span className='rule-name'>/improve</span> — replaced on each save, never appended
        </span>
      </div>
      <form
        className='idea-comment-edit'
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(text.trim());
        }}>
        <textarea
          value={text}
          rows={4}
          placeholder='What should whoever builds this know?'
          onChange={(e) => setText(e.target.value)}
        />
        <div className='idea-controls'>
          <button
            type='submit'
            className='btn-primary'
            disabled={save.isPending || text.trim() === (idea.comment ?? '')}>
            Save
          </button>
          {idea.comment && (
            <button
              type='button'
              className='btn-quiet'
              disabled={save.isPending}
              onClick={() => (setText(''), save.mutate(''))}>
              Clear
            </button>
          )}
        </div>
      </form>
      {save.error && <div className='suggestion-mark-error'>{(save.error as Error).message}</div>}
    </div>
  );
}

function IdeaSkeleton() {
  return (
    <>
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='18%' h='0.95em' />
        </div>
        <SkeletonText lines={3} />
      </div>
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='14%' h='0.95em' />
        </div>
        <SkeletonText lines={2} />
      </div>
    </>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  // The slug alone: the area is never in a permalink, so re-filing cannot break a link.
  path: '/ideas/$slug',
  component: IdeaDetailPage,
  staticData: { title: 'Idea' },
});
