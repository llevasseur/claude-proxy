import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { BookOpen, Search } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { type ConceptRow, type ConceptSearchField, type ConceptSearchHit, getConcepts, searchConcepts } from '../api';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonTable } from '../components/Skeleton';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import type { NavEntry } from './nav';

/**
 * "Concepts" — every term `/teach` has explained, newest first.
 *
 * The list is the store: `logs/concepts.jsonl` is append-only and nothing retracts a
 * line, so there is no paging — a term taught twice appears twice, which is itself worth
 * seeing. Each row opens its own page, addressed by `ord` — the line the record sits on,
 * since the term can repeat.
 *
 * **The search box is not a filter over the rows below it.** The table renders four
 * fields; a record also carries `notes`, `tips`, `sources` and `surfacedSkills`, which
 * are the bulk of what `/teach` wrote and appear nowhere on this page. `/api/concepts/search`
 * reads all eight — over the hosted store's own bm25 index when that store is the backing —
 * so a query reaches prose no amount of scanning this table could.
 *
 * The row pipeline below is deliberately three named steps — **source, narrow, order** —
 * because a second narrowing dimension (facets over field and skill) is queued behind this
 * one, and it joins at `narrowed` without touching either end.
 */

type SortKey = 'term' | 'field' | 'savedAt';
type SortDir = 'asc' | 'desc';
type Sort = { key: SortKey; dir: SortDir };

/** What a column sorts as when you first click it — dates newest first, names A→Z. */
const DEFAULT_DIR: Record<SortKey, SortDir> = { term: 'asc', field: 'asc', savedAt: 'desc' };

/**
 * How long the box waits before asking.
 *
 * Well under the 600ms the SSE routes debounce at: that number paces a stream nobody
 * asked for, while this one sits between a keystroke and an answer, where the delay is
 * felt. The corpus is small and the request is one indexed read.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** A row as the table renders it: the record, plus why it is here when a search put it here. */
type ConceptMatch = ConceptSearchHit;

/** The corpus as rows, carrying no match — nothing searched for them. */
function asMatch(concept: ConceptRow): ConceptMatch {
  return { concept, score: null, matchedIn: [], excerpt: null };
}

/** The fields the table shows. A match in one of these is already on the page. */
const RENDERED_FIELDS: readonly ConceptSearchField[] = ['term', 'sentence', 'field', 'skills'];

/** How a matched field is named to a reader. */
const FIELD_LABEL: Record<ConceptSearchField, string> = {
  term: 'term',
  sentence: 'explanation',
  field: 'field',
  skills: 'skills',
  notes: 'notes',
  tips: 'tips',
  sources: 'sources',
  surfacedSkills: 'surfaced skills',
};

/** `value`, but only after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function ConceptsPage() {
  const query = useQuery({ queryKey: ['concepts'], queryFn: getConcepts });
  // Live: `/teach` appends from outside the server, so the page follows the file.
  const live = useLiveQuery('/api/concepts/stream', ['concepts']);
  const navigate = useNavigate();
  const [sort, setSort] = useState<Sort>({ key: 'savedAt', dir: 'desc' });
  const [typed, setTyped] = useState('');
  const q = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);
  const searching = q.length > 0;
  const data = query.data;
  const concepts = data?.concepts ?? [];

  const search = useQuery({
    queryKey: ['concepts', 'search', q],
    queryFn: () => searchConcepts(q),
    enabled: searching,
  });

  /**
   * Relevance is the order a fresh search arrives in, and clicking a column is how a
   * reader leaves it. A new query restores it, since the ranking is what was just asked
   * for.
   */
  const [byRelevance, setByRelevance] = useState(true);
  // Reset during render on the query changing, rather than in an effect: the effect
  // form declares a dependency it never reads, and this renders the restored order
  // in the same pass instead of one frame of the old one.
  const [orderedFor, setOrderedFor] = useState(q);
  if (orderedFor !== q) {
    setOrderedFor(q);
    setByRelevance(true);
  }

  const onSort = (key: SortKey) => {
    setByRelevance(false);
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );
  };

  // --- The row pipeline: source, narrow, order. ---
  // 1. Source. A search replaces the corpus rather than filtering it in place: the
  //    matches are not a subset of what the table can see, so filtering rows would
  //    reach strictly less than this does.
  const source: ConceptMatch[] = useMemo(
    () => (searching ? (search.data?.results ?? []) : concepts.map(asMatch)),
    [searching, search.data, concepts],
  );
  // 2. Narrow. Nothing narrows the source yet; the facet rail joins here.
  const narrowed = source;
  // 3. Order. Relevance is an order the rows arrived in rather than a key to sort by,
  //    so it is the absence of a sort rather than a fourth `SortKey`.
  const relevanceOrder = searching && byRelevance;
  const rows = useMemo(
    () => (relevanceOrder ? narrowed : sortRows(narrowed, sort.key, sort.dir)),
    [narrowed, relevanceOrder, sort],
  );
  // A sorted-by column is only marked as such when a sort is what put the rows in order.
  const activeSort = relevanceOrder ? null : sort;

  return (
    <section>
      <div className='pagehead'>
        <h1>Concepts</h1>
        <LiveIndicator status={live} />
      </div>
      <div className='muted' style={{ marginBottom: 16 }}>
        What <span className='rule-name'>/teach</span> has recorded, from{' '}
        <span className='rule-name'>{data?.meta.storePath ?? 'logs/concepts.jsonl'}</span>.
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ConceptsSkeleton />}>
        {concepts.length === 0 ? (
          <div className='card empty'>
            Nothing taught yet. Run <span className='rule-name'>/teach &lt;term&gt;</span> in a session and it lands
            here.
          </div>
        ) : (
          <div className='card'>
            <div className='card-head'>
              <h2>Corpus</h2>
              <label className='sessions-search context-search'>
                <Search size={14} strokeWidth={1.75} aria-hidden />
                <input
                  type='search'
                  value={typed}
                  placeholder='Search the whole record — notes included'
                  aria-label='Search concepts by any of their text, including the notes this table does not show'
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
              <span className='muted'>
                <SearchCaption
                  searching={searching}
                  shown={rows.length}
                  total={concepts.length}
                  ranked={search.data?.ranked ?? false}
                  loading={search.isFetching}
                />
              </span>
            </div>
            {search.error ? (
              <div className='muted' style={{ marginBottom: 12 }}>
                That search did not come back: {search.error.message}
              </div>
            ) : null}
            {searching && rows.length === 0 && !search.isFetching ? (
              <div className='empty'>
                Nothing in the corpus mentions <span className='rule-name'>{q}</span> — not in a term, and not in the
                notes behind one.
              </div>
            ) : (
              <div className='table-scroll' style={{ marginTop: 12 }}>
                <table className='table'>
                  <thead>
                    <tr>
                      <SortHeader label='Term' sortKey='term' sort={activeSort} onSort={onSort} style={COLUMN.term} />
                      <th style={COLUMN.sentence}>Explanation</th>
                      <SortHeader
                        label='Field'
                        sortKey='field'
                        sort={activeSort}
                        onSort={onSort}
                        style={COLUMN.field}
                      />
                      <th style={COLUMN.skills}>Skills</th>
                      <SortHeader
                        label='Saved'
                        sortKey='savedAt'
                        sort={activeSort}
                        onSort={onSort}
                        style={COLUMN.saved}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ concept: c, matchedIn, excerpt }) => (
                      <tr
                        key={c.ord}
                        className='clickable'
                        onClick={() => navigate({ to: '/concepts/$ord', params: { ord: String(c.ord) } })}>
                        <td className='rule-name' style={COLUMN.term}>
                          {c.term}
                        </td>
                        <td style={COLUMN.sentence}>
                          {c.sentence || <span className='muted'>—</span>}
                          <MatchNote matchedIn={matchedIn} excerpt={excerpt} />
                        </td>
                        <td style={COLUMN.field}>
                          {c.field ? (
                            <span className='badge neutral'>{c.field}</span>
                          ) : (
                            <span className='muted'>—</span>
                          )}
                        </td>
                        <td style={COLUMN.skills}>
                          {c.skills.length === 0 ? (
                            <span className='muted'>—</span>
                          ) : (
                            c.skills.map((skill) => (
                              <span className='badge sev-info' key={skill} style={{ marginRight: 4 }}>
                                {skill}
                              </span>
                            ))
                          )}
                        </td>
                        <td className='muted' style={COLUMN.saved}>
                          {formatSaved(c.savedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </QueryState>
    </section>
  );
}

/**
 * Per-column floors — every column needs one, or a wrap in Term just
 * redistributes the squeeze onto its neighbours. Their sum is wider than a
 * phone, which is what `.table-scroll` is for. Saved stays `nowrap`: a split
 * timestamp reads as two values.
 */
const COLUMN = {
  term: { minWidth: 140 },
  sentence: { minWidth: 260 },
  field: { minWidth: 110 },
  skills: { minWidth: 160 },
  saved: { minWidth: 150, whiteSpace: 'nowrap' },
} as const satisfies Record<string, CSSProperties>;

/**
 * What the head of the card says about what is on it.
 *
 * The unsearched line is the one that was always there. The searched line has to say
 * **which** search answered, because the two are not the same promise: the hosted store
 * ranks by relevance over the whole record, while the local file has no such index and
 * gets an honest substring pass instead.
 */
function SearchCaption({
  searching,
  shown,
  total,
  ranked,
  loading,
}: {
  searching: boolean;
  shown: number;
  total: number;
  ranked: boolean;
  loading: boolean;
}) {
  if (!searching) {
    return (
      <>
        <strong>{total}</strong> concept{total === 1 ? '' : 's'} saved · click a column to sort · click a row to read
        the detail
      </>
    );
  }
  if (loading) return <>searching the whole corpus…</>;
  return (
    <>
      <strong>{shown}</strong> of {total} · {ranked ? 'ranked by relevance' : 'unranked substring matches'} over every
      field, notes included
      {ranked ? '' : ' — the local store has no ranked search'}
    </>
  );
}

/**
 * Why a row is in a set of results, when the reason is not on the row.
 *
 * A match in a rendered column needs no note — the reader can see it. A match in the
 * prose does, and the excerpt is that note: it is the only place on this page the
 * `notes` text ever appears.
 */
function MatchNote({ matchedIn, excerpt }: { matchedIn: ConceptSearchField[]; excerpt: string | null }) {
  const hidden = matchedIn.filter((field) => !RENDERED_FIELDS.includes(field));
  if (hidden.length === 0) return null;
  return (
    <div className='muted' style={{ marginTop: 6 }}>
      <span className='badge sev-info' style={{ marginRight: 4 }}>
        {hidden.map((field) => FIELD_LABEL[field]).join(' · ')}
      </span>
      {excerpt}
    </div>
  );
}

/** A sortable column head — click to sort, click again to reverse. */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  style,
}: {
  label: string;
  sortKey: SortKey;
  /** `null` when the rows are in an order no column produced — a search's ranking. */
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  style?: CSSProperties;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      className='sortable'
      style={style}
      aria-sort={active && sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && sort && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

/**
 * A sorted copy. Ties fall back to `ord` descending, so equal fields — an empty
 * one, most often — keep a stable order between renders.
 *
 * Sorts the rows rather than the records, so a search's result set sorts by the same
 * three columns the corpus does and keeps its match note with its row.
 */
function sortRows(rows: ConceptMatch[], key: SortKey, dir: SortDir): ConceptMatch[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort(({ concept: a }, { concept: b }) => {
    const cmp =
      key === 'savedAt'
        ? a.savedAt.localeCompare(b.savedAt)
        : a[key].localeCompare(b[key], undefined, { sensitivity: 'base' });
    return cmp !== 0 ? cmp * sign : b.ord - a.ord;
  });
}

/** Local date and time; an unparseable timestamp is shown as recorded. */
function formatSaved(savedAt: string): string {
  const at = new Date(savedAt);
  return Number.isNaN(at.getTime()) ? savedAt : at.toLocaleString();
}

const CONCEPT_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '60%' },
  {},
  { cell: '50%' },
  { cell: '70%' },
  { cell: '44%' },
];

function ConceptsSkeleton() {
  return (
    <div className='card'>
      <div className='muted' aria-hidden>
        <Skeleton w='32%' />
      </div>
      {/* Same wrapper and offset as the real table, so the swap doesn't shift. */}
      <div className='table-scroll' style={{ marginTop: 12 }}>
        <SkeletonTable columns={CONCEPT_COLUMNS} rows={6} />
      </div>
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/concepts',
  component: ConceptsPage,
  staticData: { title: 'Concepts' },
});

export const nav = {
  section: 'Learning',
  to: '/concepts',
  label: 'Concepts',
  hint: '/teach',
  exact: false,
  icon: BookOpen,
} as const satisfies NavEntry;
