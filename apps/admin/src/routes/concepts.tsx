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
 * appear nowhere on this page. `/api/concepts/search` reads all eight, over the hosted
 * store's bm25 index when that store is the backing.
 *
 * The row pipeline below is three named steps — source, narrow, order. **The facet rail
 * narrows at `narrowed`**, so the two questions this page answers compose rather than
 * replace one another: the search box chooses *which corpus* is being read, the rail
 * chooses *which part of it*, and a row has to survive both.
 */

type SortKey = 'term' | 'field' | 'savedAt';
type SortDir = 'asc' | 'desc';
type Sort = { key: SortKey; dir: SortDir };

/** What a column sorts as when you first click it — dates newest first, names A→Z. */
const DEFAULT_DIR: Record<SortKey, SortDir> = { term: 'asc', field: 'asc', savedAt: 'desc' };

/** How long the box waits before asking. Well under the 600ms the SSE routes debounce at. */
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

/* --- Facets: the index the Field column does not make on its own. --- */

/**
 * What separates a compound field into segments.
 *
 * **Spaced on both sides, deliberately.** `loading-state UI` and `JavaScript/TypeScript
 * module resolution` each carry a hyphen or a slash *inside* a word, and splitting on a
 * bare one would file those two concepts under `loading` and `JavaScript`. The dash is
 * matched in all three of its forms because the corpus has written the same separator as
 * a hyphen, an en dash and an em dash, and which one a record used is not a distinction
 * anybody meant to draw.
 */
const FIELD_SEPARATOR = /\s+[-–—/]\s+/;

/**
 * The bucket a row falls in when the dimension says nothing about it — no field, or no
 * skill. A control character, so it can never be a value the corpus also holds.
 */
const UNSET = '\u0000unset';

/** The two dimensions the rail offers. */
type FacetKind = 'field' | 'skill';

/** What is selected, per dimension — lowercased facet keys. */
type FacetSelection = Record<FacetKind, readonly string[]>;

const NO_SELECTION: FacetSelection = { field: [], skill: [] };

/**
 * The group a concept's field names: its **leading segment**, not the field itself.
 *
 * Every stored field is a bespoke phrase written by the run that taught the term, so
 * grouping on the raw value makes exactly one group per row and the rail says nothing at
 * all. A compound field is written `<area> — <speciality>` or `<area> / <speciality>`,
 * and the area is the part two concepts can share. A field with no separator is already
 * one segment and stands as its own area — that is the common case in today's corpus
 * rather than a shape to correct for.
 */
function fieldSegment(field: string): string {
  return field.split(FIELD_SEPARATOR)[0]?.trim() || UNSET;
}

/** The values of each dimension a concept carries. */
const FACET_VALUES: Record<FacetKind, (concept: ConceptRow) => readonly string[]> = {
  field: (concept) => [fieldSegment(concept.field)],
  skill: (concept) => (concept.skills.length > 0 ? concept.skills : [UNSET]),
};

/** One line of the rail: a value, how it is written, and how many concepts carry it. */
interface Facet {
  /** Lowercased, so two spellings of one area are one facet. */
  key: string;
  /** As the corpus first wrote it — or the name of the empty bucket. */
  label: string;
  count: number;
}

/** What the empty bucket is called, which reads differently per dimension. */
const UNSET_LABEL: Record<FacetKind, string> = { field: 'No field', skill: 'No skill' };

/**
 * One dimension's facets over `rows`, commonest first.
 *
 * `keep` is the current selection, whose keys stay on the rail at count 0 rather than
 * disappearing — a selection you cannot see is a selection you cannot undo, and a new
 * search routinely empties one. The empty bucket sorts last whatever its count: it is
 * the residue of the dimension, not a topic within it.
 */
function facetsOf(rows: readonly ConceptMatch[], kind: FacetKind, keep: readonly string[]): Facet[] {
  const found = new Map<string, Facet>();
  for (const key of keep) found.set(key, { key, label: key, count: 0 });
  for (const { concept } of rows) {
    for (const value of FACET_VALUES[kind](concept)) {
      const key = value.toLowerCase();
      const seen = found.get(key);
      if (!seen) {
        found.set(key, { key, label: value, count: 1 });
        continue;
      }
      seen.count += 1;
      // A kept key was seeded from the lowercased selection; prefer the corpus spelling.
      if (seen.label === key) seen.label = value;
    }
  }
  return [...found.values()]
    .map((facet) => (facet.key === UNSET ? { ...facet, label: UNSET_LABEL[kind] } : facet))
    .sort((a, b) => {
      if ((a.key === UNSET) !== (b.key === UNSET)) return a.key === UNSET ? 1 : -1;
      return b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
}

/** Whether a concept survives one dimension's selection. An empty selection selects all. */
function inSelection(concept: ConceptRow, kind: FacetKind, selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  return FACET_VALUES[kind](concept).some((value) => selected.includes(value.toLowerCase()));
}

/** The selection with one key flipped. */
function toggleFacet(selection: FacetSelection, kind: FacetKind, key: string): FacetSelection {
  const current = selection[kind];
  return { ...selection, [kind]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key] };
}

/**
 * The rail's groups, in the order they are read.
 *
 * **Fields lead and skills follow, because the two are not the same size of axis.** Most
 * of the corpus carries no skill at all, so that dimension is mostly a single bucket.
 * That bucket is shown rather than hidden — "never linked to a skill" is a gap a reader
 * would reasonably want to select — but a dimension that is empty for most records does
 * not get promoted to the primary one, and dropping skills entirely would answer a
 * different question than the one asked.
 */
const FACET_GROUPS: readonly { kind: FacetKind; heading: string; hint: string }[] = [
  { kind: 'field', heading: 'Field', hint: 'the leading segment of each stored field' },
  { kind: 'skill', heading: 'Skill', hint: 'most records carry none' },
];

export function ConceptsPage() {
  const query = useQuery({ queryKey: ['concepts'], queryFn: getConcepts });
  // Live: `/teach` appends from outside the server, so the page follows the file.
  const live = useLiveQuery('/api/concepts/stream', ['concepts']);
  const navigate = useNavigate();
  const [sort, setSort] = useState<Sort>({ key: 'savedAt', dir: 'desc' });
  const [typed, setTyped] = useState('');
  const [facets, setFacets] = useState<FacetSelection>(NO_SELECTION);
  const q = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);
  const searching = q.length > 0;
  const data = query.data;
  const concepts = data?.concepts ?? [];

  const search = useQuery({
    queryKey: ['concepts', 'search', q],
    queryFn: () => searchConcepts(q),
    enabled: searching,
  });

  // Relevance is the order a fresh search arrives in; clicking a column leaves it, and a
  // new query restores it — reset during render, so no frame shows the old order.
  const [byRelevance, setByRelevance] = useState(true);
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
  // 1. Source. A search replaces the corpus rather than filtering it: the matches are
  //    not a subset of what the table can see.
  const source: ConceptMatch[] = useMemo(
    () => (searching ? (search.data?.results ?? []) : concepts.map(asMatch)),
    [searching, search.data, concepts],
  );
  // 2. Narrow. The facet rail joins here, and it **intersects** rather than replaces:
  //    a selection within one dimension is an OR, the two dimensions are ANDed with
  //    each other, and the whole thing is applied to whatever the search left in
  //    `source`. A rail that reset the search would undo the step above it.
  const picked = facets.field.length + facets.skill.length;
  const narrowed = useMemo(
    () =>
      picked === 0
        ? source
        : source.filter(
            ({ concept }) => inSelection(concept, 'field', facets.field) && inSelection(concept, 'skill', facets.skill),
          ),
    [source, facets, picked],
  );
  // The rail counts `source`, not `narrowed`: a facet's count says what selecting it
  // would give you over the corpus currently in view, so the numbers stay legible
  // instead of collapsing to 0 and 1 as soon as anything is picked. They do follow the
  // search, because a count that outran the table would be describing another page.
  const rail = useMemo(
    () => FACET_GROUPS.map((group) => ({ ...group, facets: facetsOf(source, group.kind, facets[group.kind]) })),
    [source, facets],
  );
  // 3. Order. Relevance is the order the rows arrived in — the absence of a sort, not a
  //    fourth `SortKey`.
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
                  faceted={picked > 0}
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
            <div style={LAYOUT.split}>
              <FacetRail
                groups={rail}
                selection={facets}
                picked={picked}
                onToggle={(kind, key) => setFacets((prev) => toggleFacet(prev, kind, key))}
                onClear={() => setFacets(NO_SELECTION)}
              />
              <div style={LAYOUT.list}>
                {rows.length === 0 && !search.isFetching ? (
                  <NoRows q={q} searching={searching} faceted={picked > 0} />
                ) : (
                  <div className='table-scroll'>
                    <table className='table'>
                      <thead>
                        <tr>
                          <SortHeader
                            label='Term'
                            sortKey='term'
                            sort={activeSort}
                            onSort={onSort}
                            style={COLUMN.term}
                          />
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
            </div>
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
 * How the rail and the table share the card.
 *
 * The split is flex `wrap` rather than a media query, because this page states its
 * layout inline — as the column floors above already do — and an inline style cannot
 * carry a breakpoint. It does not need one: each child declares its own basis, so the
 * rail sits beside the table while both fit on a line and folds above it when they do
 * not, at whatever width that turns out to be rather than at a number picked here.
 */
const LAYOUT = {
  split: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20, marginTop: 12 },
  rail: { flex: '1 1 200px', minWidth: 190, maxWidth: 280 },
  // Grows far harder than the rail, so spare width goes to the table rather than being
  // split between them — but shares the same wrap, so neither is ever crushed.
  list: { flex: '999 1 400px', minWidth: 0 },
} as const satisfies Record<string, CSSProperties>;

const RAIL = {
  head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
  // No family and no tracking: both were there to open up a monospaced title, and the
  // rail's headings are interface text rather than data.
  title: { fontSize: 'var(--text-4)' },
  clear: {
    background: 'transparent',
    border: 'none',
    padding: 0,
    color: 'var(--signal)',
    cursor: 'pointer',
    fontSize: 'var(--text-3)',
  },
  group: { marginBottom: 18 },
  groupHead: { fontSize: 'var(--text-3)' },
  hint: { fontSize: 'var(--text-3)', marginBottom: 6 },
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  count: { flex: 'none', fontVariantNumeric: 'tabular-nums' },
} as const satisfies Record<string, CSSProperties>;

/** A facet line — bordered only while it is on, so the rail reads as text until used. */
function facetStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    width: '100%',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    textAlign: 'left',
    background: active ? 'var(--surface-2)' : 'transparent',
    color: active ? 'var(--signal)' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--signal-dim)' : 'transparent'}`,
    borderRadius: 'var(--radius-3)',
    padding: '4px 6px',
    cursor: 'pointer',
    fontSize: 'var(--text-4)',
  };
}

/**
 * The rail: the corpus as an index, one line per group with the size of that group.
 *
 * **A facet is a toggle, not a radio.** Single-select would be the wrong control for
 * this corpus — most areas hold a single concept, so a radio could only ever show one
 * row and the page would lose the ability to assemble a reading list. Within a group
 * the picks are ORed; the two groups are ANDed with each other and with the search.
 */
function FacetRail({
  groups,
  selection,
  picked,
  onToggle,
  onClear,
}: {
  groups: readonly { kind: FacetKind; heading: string; hint: string; facets: Facet[] }[];
  selection: FacetSelection;
  picked: number;
  onToggle: (kind: FacetKind, key: string) => void;
  onClear: () => void;
}) {
  return (
    <aside style={LAYOUT.rail} aria-label='Group the corpus by field and by skill'>
      <div style={RAIL.head}>
        <span style={RAIL.title}>INDEX</span>
        {picked > 0 ? (
          <button type='button' style={RAIL.clear} onClick={onClear}>
            clear {picked}
          </button>
        ) : null}
      </div>
      {groups.map(({ kind, heading, hint, facets }) => (
        <div key={kind} style={RAIL.group}>
          <div className='muted' style={RAIL.groupHead}>
            {heading.toUpperCase()}
          </div>
          <div className='muted' style={RAIL.hint}>
            {hint}
          </div>
          {facets.length === 0 ? (
            <div className='muted' style={RAIL.hint}>
              nothing to group by here
            </div>
          ) : (
            facets.map((facet) => {
              const active = selection[kind].includes(facet.key);
              return (
                <button
                  key={facet.key}
                  type='button'
                  aria-pressed={active}
                  title={facet.label}
                  style={facetStyle(active)}
                  onClick={() => onToggle(kind, facet.key)}>
                  <span style={RAIL.label}>{facet.label}</span>
                  <span style={RAIL.count}>{facet.count}</span>
                </button>
              );
            })
          )}
        </div>
      ))}
    </aside>
  );
}

/** Why the table is empty, which is a different sentence for each way of emptying it. */
function NoRows({ q, searching, faceted }: { q: string; searching: boolean; faceted: boolean }) {
  if (searching && faceted) {
    return (
      <div className='empty'>
        Nothing matches <span className='rule-name'>{q}</span> <em>and</em> the facets you picked. The two narrow
        together — drop one to widen.
      </div>
    );
  }
  if (searching) {
    return (
      <div className='empty'>
        Nothing in the corpus mentions <span className='rule-name'>{q}</span> — not in a term, and not in the notes
        behind one.
      </div>
    );
  }
  return <div className='empty'>No concept is filed under every facet you picked.</div>;
}

/**
 * What the head of the card says about what is on it. A searched line names **which**
 * search answered: ranked relevance and an unranked substring pass are not the same
 * promise. A faceted line says the rail narrowed it too, so a count below the total is
 * never unexplained.
 */
function SearchCaption({
  searching,
  faceted,
  shown,
  total,
  ranked,
  loading,
}: {
  searching: boolean;
  faceted: boolean;
  shown: number;
  total: number;
  ranked: boolean;
  loading: boolean;
}) {
  if (searching && loading) return <>searching the whole corpus…</>;
  if (!searching) {
    if (!faceted) {
      return (
        <>
          <strong>{total}</strong> concept{total === 1 ? '' : 's'} saved · click a facet to group · click a column to
          sort · click a row to read the detail
        </>
      );
    }
    return (
      <>
        <strong>{shown}</strong> of {total} · narrowed to the facets you picked
      </>
    );
  }
  return (
    <>
      <strong>{shown}</strong> of {total} · {ranked ? 'ranked by relevance' : 'unranked substring matches'} over every
      field, notes included{faceted ? ', then narrowed to your facets' : ''}
      {ranked ? '' : ' — the local store has no ranked search'}
    </>
  );
}

/**
 * Why a row is in a set of results, when the reason is not on the row. A match in a
 * rendered column needs no note; the excerpt is the only place on this page the `notes`
 * text ever appears.
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
