import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type ConceptRow, getConcept } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { LiveIndicator } from '../components/LiveIndicator';
import { Markdown } from '../components/Markdown';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { useLiveQuery } from '../useLiveQuery';

/**
 * One saved concept, addressed by `ord` — the line it sits on in
 * `logs/concepts.jsonl`. A term can be taught more than once, so the term is not
 * an address; the line is, because the store is only ever appended to.
 *
 * Everything past the explanation is optional — `/teach` learned to record it
 * after the first concepts were saved. A field that was never recorded renders
 * nothing at all, rather than an empty section claiming there was nothing to say.
 */
export function ConceptDetailPage() {
  const { ord } = useParams({ from: '/concepts/$ord' });
  const n = Number(ord);
  const query = useQuery({ queryKey: ['concept', ord], queryFn: () => getConcept(n) });
  // `/teach` appends from outside the server; a re-taught store re-renders here.
  const live = useLiveQuery(`/api/concepts/concept/stream?ord=${n}`, ['concept', ord]);
  const concept = query.data?.concept;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/concepts' className='link'>
          Concepts
        </Link>
        <span className='crumb-current'>{concept?.term ?? ord}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>{concept?.term ?? 'Concept'}</h1>
        <LiveIndicator status={live} />
      </div>
      <div className='muted' style={{ marginBottom: 16 }}>
        Recorded by <span className='rule-name'>/teach</span>
        {concept ? <> on {formatSaved(concept.savedAt)}</> : null}.
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ConceptSkeleton />}>
        {concept && <ConceptBody concept={concept} />}
      </QueryState>
    </section>
  );
}

function ConceptBody({ concept }: { concept: ConceptRow }) {
  const hasDetail = Boolean(
    concept.notes || concept.tips?.length || concept.sources?.length || concept.surfacedSkills?.length,
  );

  return (
    <>
      <div className='card'>
        <div className='card-head'>
          <h2>In one sentence</h2>
          {concept.field && <span className='badge neutral'>{concept.field}</span>}
        </div>
        <p>{concept.sentence || <span className='muted'>No explanation was recorded.</span>}</p>
      </div>

      <BadgeCard title='Skills applied' items={concept.skills} empty='No skills were recorded for this run.' />

      {/* Optional from here down — each card exists only if the record carries it. */}
      {concept.surfacedSkills?.length ? <BadgeCard title='Skills surfaced' items={concept.surfacedSkills} /> : null}

      {concept.notes ? (
        <div className='card'>
          <div className='card-head'>
            <h2>Research</h2>
          </div>
          <Markdown source={concept.notes} />
        </div>
      ) : null}

      {concept.tips?.length ? (
        <div className='card'>
          <div className='card-head'>
            <h2>Tips</h2>
          </div>
          <ul>
            {concept.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {concept.sources?.length ? (
        <div className='card'>
          <div className='card-head'>
            <h2>Sources</h2>
          </div>
          <ul>
            {concept.sources.map((source) => (
              <li key={source} className='mono-break'>
                {/^https?:\/\//.test(source) ? (
                  <a className='link' href={source} target='_blank' rel='noreferrer'>
                    {source}
                  </a>
                ) : (
                  source
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!hasDetail && (
        <div className='card empty'>
          This concept was saved before <span className='rule-name'>/teach</span> recorded research detail, so there is
          nothing more to show.
        </div>
      )}
    </>
  );
}

/** A card of badge-rendered strings; `empty` renders the card even with no items. */
function BadgeCard({ title, items, empty }: { title: string; items: string[]; empty?: string }) {
  if (items.length === 0 && !empty) return null;
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>{title}</h2>
      </div>
      {items.length === 0 ? (
        <div className='muted'>{empty}</div>
      ) : (
        <div className='badge-row'>
          {items.map((item) => (
            <span className='badge sev-info' key={item}>
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Local date and time; an unparseable timestamp is shown as recorded. */
function formatSaved(savedAt: string): string {
  const at = new Date(savedAt);
  return Number.isNaN(at.getTime()) ? savedAt : at.toLocaleString();
}

function ConceptSkeleton() {
  return (
    <>
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='22%' h='0.95em' />
        </div>
        <SkeletonText lines={2} />
      </div>
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='16%' h='0.95em' />
        </div>
        <SkeletonText lines={1} />
      </div>
    </>
  );
}
