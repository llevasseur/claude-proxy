import { type IdeaEntry, ideaAreaLabel, SEED_IDEA_AREAS } from '@claude-proxy/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { commentIdeas, fileIdeas, getIdeas, type IdeasResponse } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import {
  IDEA_STATUS_LABEL,
  IDEAS_KEY,
  IdeaDecisionControls,
  IdeaEvidenceList,
  IdeaRationale,
} from '../components/IdeaCard';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { fmtLocalTsShort } from '../format';
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
        <h1>{idea?.title ?? 'Idea'}</h1>
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
        <IdeaRationale rationale={idea.rationale} />
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
                <span className='mono-break'>{idea.claim.pr}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Decision — the same controls the card carries, so the rationale can be acted on here. */}
      <div className='card'>
        <div className='card-head'>
          <h2>Decision</h2>
          <span className='muted'>the same sign-off the card carries — a rejection still needs its reason</span>
        </div>
        <IdeaDecisionControls idea={idea} />
      </div>

      <AreaPicker idea={idea} areas={areas} />
      <CommentEditor idea={idea} />
    </>
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
