import type { UsageDigest } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { getTrends } from '../api';
import type { LiveStatus } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';
import { LiveIndicator } from './LiveIndicator';
import { ModelFilter, type ModelOption, modelsIn } from './ModelPicker';
import { DAY_WINDOWS, Segmented, type SegmentedOption } from './Segmented';

/**
 * The query key every trends read shares: window, then model. `null` is written out
 * rather than left off, so a filtered read cannot collide with the unfiltered one.
 */
export const trendsKey = (days: number, model: string | null) => ['trends', days, model] as const;

/**
 * The day window a page is reading, and today's digest as the stream last reported
 * it. Cards under the page head follow this unless they pin a window of their own.
 */
export interface DayWindow {
  days: number;
  today?: UsageDigest;
  /** The model every series under this head is narrowed to, or null for all of them. */
  model?: string | null;
}

/** The Overview's default window, and the fallback for a card with no page above it. */
const DEFAULT_WINDOW: DayWindow = { days: 7 };

const DayWindowContext = createContext<DayWindow>(DEFAULT_WINDOW);

export function DayWindowProvider({ value, children }: { value: DayWindow; children: ReactNode }) {
  return <DayWindowContext.Provider value={value}>{children}</DayWindowContext.Provider>;
}

/** What the page head is currently set to. */
export function usePageDayWindow(): DayWindow {
  return useContext(DayWindowContext);
}

/**
 * The right-hand cluster of a page head: the stream's health, then what is being
 * shown, then how far back. `live` is optional — a page with no stream still gets
 * the picker; so is the model filter, which only appears once `models` is passed.
 */
export function DayWindowControls({
  days,
  onDays,
  label,
  busy,
  live,
  model,
  onModel,
  models,
  modelLabel = 'Model',
}: {
  days: number;
  onDays: (next: number) => void;
  label: string;
  busy?: boolean;
  live?: LiveStatus;
  /** Selected model, or null for all. Omit both this and `onModel` for a window-only head. */
  model?: string | null;
  onModel?: (next: string | null) => void;
  models?: readonly ModelOption[];
  modelLabel?: string;
}) {
  return (
    <div className='pagehead-controls'>
      {live && <LiveIndicator status={live} />}
      {onModel && (
        <ModelFilter value={model ?? null} onSelect={onModel} options={models ?? []} label={modelLabel} busy={busy} />
      )}
      <Segmented options={DAY_WINDOWS} value={days} onSelect={onDays} label={label} busy={busy} />
    </div>
  );
}

/**
 * The models a window captured, for a picker to offer. Read from the *unfiltered*
 * window: a list built from the filtered one would empty the control that filtered
 * it. Shares the key an unfiltered page already uses, so it costs no extra fetch.
 *
 * This one keeps its placeholder unconditionally: its key never carries a model, so a
 * model switch is not a change to it, and the list of models has to stay under the
 * control that is selecting from it while the window it describes reloads.
 */
export function useModelOptions(days: number): ModelOption[] {
  const query = useQuery({
    queryKey: trendsKey(days, null),
    queryFn: () => getTrends(days),
    placeholderData: keepPreviousData,
  });
  const digests = query.data?.digests;
  return useMemo(() => modelsIn(digests ?? []), [digests]);
}

/** A card either follows the page head or pins a window of its own. */
export type CardWindow = 'follow' | number;

const CARD_WINDOWS: readonly SegmentedOption<CardWindow>[] = [{ value: 'follow', label: 'Page' }, ...DAY_WINDOWS];

/** A card's own window over the page's. Starts on `follow`; `Page` puts it back. */
export function useCardWindow(): {
  /** The window to plot: the page's while following, the pinned one after that. */
  days: number;
  choice: CardWindow;
  select: (next: CardWindow) => void;
  /** True while the re-render the switch triggered is still in flight. */
  switching: boolean;
  today?: UsageDigest;
  /** The page head's model filter. A card pins its own *window*, never its own model. */
  model: string | null;
} {
  const page = usePageDayWindow();
  const [choice, select, switching] = useTransitionState<CardWindow>('follow');
  return {
    days: choice === 'follow' ? page.days : choice,
    choice,
    select,
    switching,
    today: page.today,
    model: page.model ?? null,
  };
}

/** The card-head twin of `DayWindowControls`, carrying the extra `Page` option. */
export function CardWindowPicker({
  choice,
  onSelect,
  label,
  busy,
}: {
  choice: CardWindow;
  onSelect: (next: CardWindow) => void;
  label: string;
  busy?: boolean;
}) {
  return <Segmented options={CARD_WINDOWS} value={choice} onSelect={onSelect} label={label} busy={busy} />;
}

/**
 * Today's digest as the summary stream last reported it, spliced into a fetched
 * window — `/api/trends` is a one-shot read, so a plot would otherwise hold today's
 * load-time values while the headline moved on. `/api/trends` omits a day with
 * nothing captured, so today only joins a window it is missing from once it has
 * activity: an idle day would otherwise arrive as a row of zeros. An empty window
 * stays empty.
 */
export function withLiveToday(digests: UsageDigest[], today: UsageDigest): UsageDigest[] {
  if (digests.length === 0) return digests;
  const at = digests.findIndex((x) => x.date === today.date);
  if (at === -1) return today.requestCount > 0 ? [...digests, today] : digests;
  return digests.map((x, i) => (i === at ? today : x));
}

/**
 * Placeholder rule for a trends read: hold the previous window's numbers under the new
 * one, unless the *model* is what changed.
 *
 * A window switch asks the same models for a wider or narrower span, so the numbers it
 * supersedes are close enough to the next set to be worth sitting under them while they
 * arrive. A model switch replaces them with a different model's entirely, and that is
 * the one switch whose answer has to be unmistakable: kept in place it lands as a few
 * digits quietly changing inside an unmoved layout, which reads the same whether the
 * fetch finished or not. Dropping the placeholder puts the query back to loading, so
 * the view reloads through the skeleton it already has and the layout shifts as the new
 * values arrive — the shift is what says they did.
 */
const keepUnlessModelChanged =
  (model: string | null) =>
  <T,>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }): T | undefined => {
    // The model half of `trendsKey`. Absent on the very first read, where there is no
    // previous data to hold anyway.
    const previousModel = previousQuery?.queryKey[2] as string | null | undefined;
    return previousModel === model ? previous : undefined;
  };

/**
 * The digests for one window, narrowed to `model` when one is selected and with
 * today kept live. The key matches the page head's own query, so a card on the
 * page's window costs no extra fetch.
 *
 * Today is spliced in only for the unfiltered window: the live digest comes from
 * the summary stream, which reports the day across every model, so a filtered
 * series is a fetch behind on the day in progress rather than wrong about it.
 */
export function useWindowDigests(
  days: number,
  today?: UsageDigest,
  model: string | null = null,
): {
  digests: UsageDigest[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  /** Days the filter could not split, straight off the response — zero when unfiltered. */
  unfilterableDays: number;
} {
  const query = useQuery({
    queryKey: trendsKey(days, model),
    queryFn: () => getTrends(days, model ? [model] : undefined),
    placeholderData: keepUnlessModelChanged(model),
  });
  const fetched = query.data?.digests;
  const live = model ? undefined : today;
  const digests = useMemo(() => {
    const rows = fetched ?? [];
    return live ? withLiveToday(rows, live) : rows;
  }, [fetched, live]);

  return {
    digests,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    unfilterableDays: query.data?.meta.unfilterableDays ?? 0,
  };
}

/** What a filtered window had to leave out. Renders nothing when nothing was dropped. */
export function UnfilterableNote({ days }: { days: number }) {
  if (days <= 0) return null;
  return (
    <div className='muted filter-note'>
      {days} earlier day{days === 1 ? '' : 's'} left out: {days === 1 ? 'it is' : 'they are'} on record only as a
      finalized daily digest, which counts requests per model but not the tokens or spend behind them.
    </div>
  );
}
