import { type RefObject, useEffect, useRef } from 'react';

/** Breathing room so the revealed station never sits flush against an edge of the scroller. */
const MARGIN = 8;

/**
 * Bring the lit station into the rail's scroller, leaving it alone when it is already there —
 * the reader's own scroll position is worth keeping when it already shows where they are.
 *
 * The move is a jump, not an animation: a smooth scroll here is abandoned partway whenever the
 * incoming page's own layout lands on top of it, and the rail's job is to be right by the time
 * the reader looks at it rather than to be watched getting there.
 */
function exposeActiveStation(stations: HTMLElement): void {
  const station = stations.querySelector<HTMLElement>('.station.active');
  if (!station) return;

  const view = stations.getBoundingClientRect();
  const box = station.getBoundingClientRect();
  const above = box.top - view.top;
  const below = box.bottom - view.bottom;
  if (above >= 0 && below <= 0) return;

  // Reaching up carries the section label along, so the station arrives with its heading;
  // reaching down only has to clear the bottom edge.
  const heading = station.closest('.nav-group')?.firstElementChild ?? station;
  const by = above < 0 ? heading.getBoundingClientRect().top - view.top - MARGIN : below + MARGIN;
  stations.scrollTop += by;
}

/**
 * Keep the station for the current page visible in the rail.
 *
 * The rail scrolls on its own, so navigating away from a station low in the list — clicking the
 * wordmark on Ideas, say — otherwise leaves the rail parked where it was, with the lit Overview
 * station off screen. Re-running on `drawerOpen` covers the narrow viewport, where the rail is a
 * drawer that was off canvas when the navigation happened.
 */
export function useStationInView(pathname: string, drawerOpen: boolean): RefObject<HTMLElement> {
  const stations = useRef<HTMLElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads neither value — they are the triggers, since the lit station is found in the DOM rather than passed in
  useEffect(() => {
    const el = stations.current;
    if (!el) return;
    // A frame later: the lit class lands with this render, but the rail's own layout
    // (collapse width, drawer transform) has not necessarily settled yet.
    const frame = requestAnimationFrame(() => exposeActiveStation(el));
    return () => cancelAnimationFrame(frame);
  }, [pathname, drawerOpen]);

  return stations;
}
