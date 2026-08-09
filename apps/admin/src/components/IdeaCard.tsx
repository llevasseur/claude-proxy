import {
  type IdeaEntry,
  type IdeaEvidence,
  type IdeaStatus,
  ideaAreaLabel,
  ideaRationaleBullets,
} from '@claude-proxy/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { markIdeas } from '../api';
import { fmtLocalTsShort } from '../format';

/**
 * One idea on the ledger, as a card a human can approve or turn down.
 *
 * Reuses the `.advice` / `.card` styling the heuristic cards use so the two read
 * as one system. An idea is a proposal awaiting a sign-off rather than a reading
 * off a number, so it carries its citations and its controls in place of a
 * severity.
 */

/** Query key every ideas list shares, so one write invalidates them all. */
export const IDEAS_KEY = 'ideas';

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  claimed: 'Claimed',
  rejected: 'Rejected',
  shipped: 'Shipped',
};

/**
 * Where a citation points, in a form a reader can go and check. A judge note
 * lives in the suggestion store rather than in a file, so it is located by
 * `bucket`/`id`; everything else is a repo-relative path.
 */
export function citationOf(evidence: IdeaEvidence): string {
  if (evidence.path) return evidence.path;
  if (evidence.bucket !== undefined) return `bucket ${evidence.bucket}/${evidence.id ?? ''}`;
  return '';
}

/** What an idea cites, on every card — the evidence is what makes it approvable. */
export function IdeaEvidenceList({ evidence }: { evidence: readonly IdeaEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className='idea-evidence'>
      {evidence.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an evidence item carries no id, and two entries may legitimately cite the same path under the same source — the list is render-only and never reordered, so position is the only stable key available
        <li key={`${e.source}:${citationOf(e)}:${i}`}>
          <span className='idea-evidence-source'>{e.source}</span>
          <code className='idea-evidence-where'>{citationOf(e)}</code>
          {e.quote && <span className='idea-evidence-quote muted'>“{e.quote}”</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The rationale — a list when it is written as bullets, a paragraph when it is
 * not. `max` previews the first N bullets: the cut is by bullet rather than by
 * height because `-webkit-line-clamp` needs `display: -webkit-box`, which stops
 * a `<ul>` rendering as a list at all. `className` is the paragraph's alone, since
 * the clamp it carries is `p.idea-rationale`; the list has its own class.
 */
export function IdeaRationale({ rationale, className, max }: { rationale: string; className?: string; max?: number }) {
  const all = ideaRationaleBullets(rationale);
  if (all.length === 0) return <p className={className}>{rationale}</p>;
  const bullets = max === undefined ? all : all.slice(0, max);
  return (
    <ul className='idea-rationale-list'>
      {bullets.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a bullet carries no id and nothing stops a rationale repeating a label or a whole line — the list is render-only and never reordered, so position is the only stable key available
        <li key={`${b.label ?? ''}:${b.text}:${i}`}>
          {b.label && <strong className='idea-rationale-label'>{b.label}</strong>}
          {b.text}
        </li>
      ))}
    </ul>
  );
}

/** Whether the sign-off has a move to offer. `shipped` is terminal — nothing follows it. */
export function hasIdeaDecision(status: IdeaStatus): boolean {
  return status !== 'shipped';
}

/**
 * Accept, reject, release, undo — the whole sign-off, shared by the card and the
 * permalink so the two cannot disagree about what a status may become. `children`
 * renders on the same row, which is the timestamp on the card.
 */
export function IdeaDecisionControls({ idea, children }: { idea: IdeaEntry; children?: ReactNode }) {
  const client = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // The Reject button the form replaced leaves the tab order with it, so focus would
  // otherwise fall to the document. Keyed on the reveal, so it fires on the click that
  // opened the form rather than on every keystroke's re-render.
  const reasonRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);

  const mark = useMutation({
    mutationFn: (next: { status: IdeaStatus; note?: string }) =>
      markIdeas([{ slug: idea.slug, status: next.status, ...(next.note === undefined ? {} : { note: next.note }) }]),
    // Re-ask rather than patch: every list showing this idea moves together.
    onSuccess: () => {
      setRejecting(false);
      setReason('');
      return client.invalidateQueries({ queryKey: [IDEAS_KEY] });
    },
  });

  const decided = idea.status !== 'proposed';

  return (
    <>
      <div className='idea-controls'>
        {idea.status === 'proposed' && !rejecting && (
          <>
            {/* `accepted` is the recorded human sign-off, and the only status /improve acts on. */}
            <button
              type='button'
              className='btn-primary idea-accept'
              disabled={mark.isPending}
              onClick={() => mark.mutate({ status: 'accepted' })}>
              Accept
            </button>
            <button type='button' className='btn-quiet' disabled={mark.isPending} onClick={() => setRejecting(true)}>
              Reject
            </button>
          </>
        )}

        {rejecting && (
          // Required, not encouraged — the server refuses a rejection with no reason.
          <form
            className='idea-reject'
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) mark.mutate({ status: 'rejected', note: reason.trim() });
            }}>
            <input
              type='text'
              value={reason}
              ref={reasonRef}
              placeholder='Why not? This is what stops it being re-proposed.'
              onChange={(e) => setReason(e.target.value)}
            />
            <button type='submit' className='btn-primary' disabled={!reason.trim() || mark.isPending}>
              Reject
            </button>
            <button type='button' className='btn-quiet' disabled={mark.isPending} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </form>
        )}

        {/* Releasing is `accepted`, not `proposed` — the idea goes back on offer with its
            sign-off intact, without waiting out the six-hour expiry. */}
        {idea.status === 'claimed' && (
          <button
            type='button'
            className='btn-quiet'
            disabled={mark.isPending}
            onClick={() => mark.mutate({ status: 'accepted' })}>
            Release
          </button>
        )}

        {/* `proposed` is the undo — it un-signs an idea without erasing it or its note. */}
        {decided && idea.status !== 'shipped' && idea.status !== 'claimed' && (
          <button
            type='button'
            className='btn-quiet'
            disabled={mark.isPending}
            onClick={() => mark.mutate({ status: 'proposed' })}>
            Undo
          </button>
        )}

        {children}
      </div>

      {mark.error && <div className='suggestion-mark-error'>{(mark.error as Error).message}</div>}
    </>
  );
}

export function IdeaCard({ idea }: { idea: IdeaEntry }) {
  const when = idea.updated ? fmtLocalTsShort(idea.updated) : '';

  return (
    <div className={`card advice idea idea-${idea.status}`}>
      <div className='advice-head'>
        <span className={`badge idea-status-${idea.status}`}>{IDEA_STATUS_LABEL[idea.status]}</span>
        {/* The card stays actionable and gains a way in: the title opens the permalink,
            which carries the rationale in full, the re-file picker and the comment. */}
        <h3>
          <Link to='/ideas/$slug' params={{ slug: idea.slug }} className='link'>
            {idea.title}
          </Link>
        </h3>
        {/* Unfiled for a row written before areas existed — `ideas file` classifies it. */}
        <span className={`badge idea-area${idea.area ? '' : ' idea-area-unfiled'}`}>{ideaAreaLabel(idea.area)}</span>
        <code className='idea-repo muted'>{idea.repo}</code>
      </div>
      {/* Three bullets of a preview; the permalink carries it whole. A paragraph clamps instead. */}
      <IdeaRationale rationale={idea.rationale} className='idea-rationale' max={3} />
      <IdeaEvidenceList evidence={idea.evidence} />

      {idea.comment && <div className='suggestion-note idea-comment'>{idea.comment}</div>}

      {idea.claim && (
        <div className='suggestion-note idea-claim'>
          held by <strong>{idea.claim.by}</strong> since {fmtLocalTsShort(idea.claim.at)}
          {idea.claim.pr && (
            <>
              {' — '}
              {/* The link is what the status now follows: `ideas sync` reads this PR and ships or
                  releases the idea from it, so a reader should be one click from checking it. */}
              <a className='link' href={idea.claim.pr} target='_blank' rel='noreferrer'>
                {idea.claim.pr}
              </a>
            </>
          )}
        </div>
      )}

      {idea.note && (
        <div className='suggestion-note'>
          {idea.status === 'shipped' ? 'shipped: ' : idea.status === 'rejected' ? 'reason: ' : 'note: '}
          {idea.note}
        </div>
      )}

      <IdeaDecisionControls idea={idea}>
        {when && (
          <span className='muted idea-when'>
            updated {when}
            {idea.by && <> by {idea.by.thread}</>}
          </span>
        )}
      </IdeaDecisionControls>
    </div>
  );
}
