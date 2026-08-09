import type { UsageDigest } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { getTrends } from '../api';
import type { LiveStatus } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';
import { LiveIndicator } from './LiveIndicator';
import { DAY_WINDOWS, Segmented, type SegmentedOption } from './Segmented';

/**
 * The day window a page is reading, and today's digest as the stream last reported
 * it. Every card under the page head follows this unless it is asked not to.
 */
export interface DayWindow {
  days: number;
  today?: UsageDigest;
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
 * The right-hand cluster of a page head: the stream's health beside the window
 * switcher. This is the one definition of that control — the Overview and the
 * Trends page render this rather than each assembling the pair themselves.
 *
 * `live` is optional so a page with no stream behind it can still carry the picker.
 */
export function DayWindowControls({
  days,
  onDays,
  label,
  busy,
  live,
}: {
  days: number;
  onDays: (next: number) => void;
  label: string;
  busy?: boolean;
  live?: LiveStatus;
}) {
  return (
    <div className='pagehead-controls'>
      {live && <LiveIndicator status={live} />}
      <Segmented options={DAY_WINDOWS} value={days} onSelect={onDays} label={label} busy={busy} />
    </div>
  );
}

/** A card either follows the page head or pins a window of its own. */
export type CardWindow = 'follow' | number;

/** `Page` first, because following is where a card starts and what it returns to. */
const CARD_WINDOWS: readonly SegmentedOption<CardWindow>[] = [{ value: 'follow', label: 'Page' }, ...DAY_WINDOWS];

/**
 * A card's own window over the page's. It starts on `follow`, so the page head
 * speaks for the card until the card is told otherwise — and `Page` puts it back.
 */
export function useCardWindow(): {
  /** The window to plot: the page's while following, the pinned one after that. */
  days: number;
  choice: CardWindow;
  select: (next: CardWindow) => void;
  /** True while the re-render the switch triggered is still in flight. */
  switching: boolean;
  today?: UsageDigest;
} {
  const page = usePageDayWindow();
  const [choice, select, switching] = useTransitionState<CardWindow>('follow');
  return { days: choice === 'follow' ? page.days : choice, choice, select, switching, today: page.today };
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
 * window. `/api/trends` is a one-shot read, so a plot would otherwise hold today's
 * load-time values while the headline moved on. An empty window stays empty: a
 * page with nothing captured should say so rather than show a single zero day.
 */
export function withLiveToday(digests: UsageDigest[], today: UsageDigest): UsageDigest[] {
  if (digests.length === 0) return digests;
  const at = digests.findIndex((x) => x.date === today.date);
  if (at === -1) return [...digests, today];
  return digests.map((x, i) => (i === at ? today : x));
}

/**
 * The digests for one window, with today kept live. The key matches the one the
 * page head's own query uses, so a card that is following costs no extra fetch and
 * a card that pins the page's window shares its cache entry too.
 */
export function useWindowDigests(
  days: number,
  today?: UsageDigest,
): { digests: UsageDigest[]; isLoading: boolean; isFetching: boolean; error: Error | null } {
  const query = useQuery({
    queryKey: ['trends', days],
    queryFn: () => getTrends(days),
    placeholderData: keepPreviousData,
  });
  const fetched = query.data?.digests;
  const digests = useMemo(() => {
    const rows = fetched ?? [];
    return today ? withLiveToday(rows, today) : rows;
  }, [fetched, today]);

  return { digests, isLoading: query.isLoading, isFetching: query.isFetching, error: query.error };
}
