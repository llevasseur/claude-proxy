import { type IdeaEntry, ideaAreaLabel, SEED_IDEA_AREAS, UNFILED_IDEA_AREA_LABEL } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { getIdeas, type IdeasResponse } from '../api';
import { IDEAS_KEY, IdeaCard } from '../components/IdeaCard';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { SkeletonCardList } from '../components/Skeleton';
import { type JsonRecord, textField } from '../json';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import type { NavEntry } from './nav';

/**
 * The ideas ledger, one area at a time.
 *
 * Fetches the **whole** ledger once and filters client-side, so switching tabs
 * costs no request, and stays live over the same `/api/ideas/stream` subscription
 * the Advice page used.
 *
 * **There is no "All" tab**, deliberately: a mixed batch is adjudicated tab by
 * tab, so every list here is a list of *comparable* things — "is this worth
 * building" reads differently for a UI polish item than for an infrastructure
 * change.
 */

/**
 * The Unfiled tab's URL value. Deliberately **not** a valid area — a leading dash
 * fails `isIdeaArea` — so an agent that invents an area literally named `unfiled`
 * can never collide with the bucket for rows that carry no area at all.
 */
const UNFILED_TAB = '-unfiled';

/** The single panel the strip swaps, and the tab ids that label it. */
const PANEL_ID = 'idea-area-panel';
const tabId = (area: string) => `idea-area-tab-${area}`;

interface IdeaTab {
  /** The `?area=` value. */
  value: string;
  label: string;
  count: number;
}

/** Every tab, in render order: the seeds, then invented areas A–Z, then Unfiled. */
function tabsOf(areas: Record<string, number>, unfiled: number): IdeaTab[] {
  const seeds = SEED_IDEA_AREAS.map((s) => ({ value: s.area, label: s.label, count: areas[s.area] ?? 0 }));
  const seedNames = new Set(SEED_IDEA_AREAS.map((s) => s.area));
  // Anything an agent invented. Alphabetical, since nothing orders them.
  const invented = Object.keys(areas)
    .filter((area) => !seedNames.has(area))
    .sort()
    .map((area) => ({ value: area, label: ideaAreaLabel(area), count: areas[area] ?? 0 }));
  // Only while there is something to file — once every legacy row is classified it
  // disappears for good rather than sitting there empty.
  const unfiledTab = unfiled > 0 ? [{ value: UNFILED_TAB, label: UNFILED_IDEA_AREA_LABEL, count: unfiled }] : [];
  return [...seeds, ...invented, ...unfiledTab];
}

export function IdeasPage() {
  const query = useQuery({ queryKey: [IDEAS_KEY], queryFn: getIdeas });
  const live = useLiveQuery<IdeasResponse>('/api/ideas/stream', [IDEAS_KEY]);
  const search = useSearch({ from: '/ideas' });
  const navigate = useNavigate({ from: '/ideas' });

  const rows = query.data?.rows ?? [];
  const areas = query.data?.meta.areas;
  const tabs = tabsOf(areas?.areas ?? {}, areas?.unfiled ?? 0);
  // The first tab holding anything, so a fresh visit lands on rows rather than on
  // an empty UI/UX tab.
  const fallback = tabs.find((t) => t.count > 0)?.value ?? tabs[0]?.value ?? '';
  // An area that was deleted, renamed, or never existed degrades to the default
  // rather than erroring.
  const area = search.area;
  const selected = area !== undefined && tabs.some((t) => t.value === area) ? area : fallback;

  const shown = rows
    .filter((r) => (selected === UNFILED_TAB ? !r.area : r.area === selected))
    // Newest first, unlike the ledger's own oldest-first order.
    .sort((a: IdeaEntry, b: IdeaEntry) => b.created.localeCompare(a.created));
  const counts = query.data?.meta.counts;

  return (
    <section>
      <div className='pagehead'>
        <h1>Ideas</h1>
        <LiveIndicator status={live} />
      </div>
      <div className='muted' style={{ marginBottom: 16 }}>
        Invented proposals, filed by area. Only <strong>accepted</strong> is a sign-off, and it is the one status{' '}
        <span className='rule-name'>/improve</span> acts on.
        {counts ? ` · ${counts.proposed} awaiting a decision across the ledger` : ''}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SkeletonCardList count={3} lines={4} />}>
        {rows.length === 0 ? (
          <div className='card empty'>
            No ideas on the ledger. <code>/ideate</code> proposes them; each one cites evidence a person wrote down.
          </div>
        ) : (
          <>
            {/* Area tabs. The seeds render even at zero, dimmed. */}
            <div className='idea-tabs' role='tablist' aria-label='Idea areas'>
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  id={tabId(tab.value)}
                  type='button'
                  role='tab'
                  aria-selected={tab.value === selected}
                  aria-controls={PANEL_ID}
                  className={`idea-tab${tab.value === selected ? ' is-selected' : ''}${tab.count === 0 ? ' is-empty' : ''}`}
                  onClick={() => navigate({ search: { area: tab.value } })}>
                  {tab.label}
                  <span className='idea-tab-count'>{tab.count}</span>
                </button>
              ))}
            </div>

            {/* One panel the strip swaps out, labelled by whichever tab is selected. */}
            {shown.length === 0 ? (
              <div className='card empty' id={PANEL_ID} role='tabpanel' aria-labelledby={tabId(selected)}>
                Nothing filed under {tabs.find((t) => t.value === selected)?.label ?? selected} yet.
              </div>
            ) : (
              <div className='advice-list wide' id={PANEL_ID} role='tabpanel' aria-labelledby={tabId(selected)}>
                {shown.map((idea) => (
                  <IdeaCard key={idea.slug} idea={idea} />
                ))}
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/**
 * `?area=` is the selected tab, so a filtered view is linkable and survives a
 * reload. An unreadable one is dropped here and the page falls back to its
 * default view — a renamed or deleted area must degrade, never error.
 */
export interface IdeasSearch {
  area?: string;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ideas',
  component: IdeasPage,
  staticData: { title: 'Ideas' },
  validateSearch: (search: JsonRecord): IdeasSearch => {
    const area = textField(search, 'area');
    return area ? { area } : {};
  },
});

/** Beside Advice, which kept the coaching and handed the ledger over to this page. */
export const nav = {
  section: 'Learning',
  to: '/ideas',
  label: 'Ideas',
  hint: 'by area',
  exact: false,
  icon: Sparkles,
} as const satisfies NavEntry;
