import { type RefObject, useEffect, useRef } from 'react';

/** Breathing room so the revealed station never sits flush against an edge of the scroller. */
const MARGIN = 8;

/**
 * Bring the lit station into the rail's scroller; no-op when it is already visible.
 *
 * The move is a jump, not an animation — a smooth container scroll here is abandoned partway
 * when the incoming page's own layout lands on top of it.
 */
function exposeActiveStation(stations: HTMLElement): void {
  const station = stations.querySelector<HTMLElement>('.station.active');
  if (!station) return;

  const view = stations.getBoundingClientRect();
  const box = station.getBoundingClientRect();
  const above = box.top - view.top;
  const below = box.bottom - view.bottom;
  if (above >= 0 && below <= 0) return;

  // Reaching up stops at the section heading, so the station arrives labelled; reaching down
  // only has to clear the bottom edge.
  const heading = station.closest('.nav-group')?.firstElementChild ?? station;
  const by = above < 0 ? heading.getBoundingClientRect().top - view.top - MARGIN : below + MARGIN;
  stations.scrollTop += by;
}

/**
 * Keep the current page's station visible in the rail, which scrolls independently of the page.
 * Re-runs on `drawerOpen` for the narrow viewport, where the rail is a drawer that was off canvas
 * when the navigation happened.
 */
export function useStationInView(pathname: string, drawerOpen: boolean): RefObject<HTMLElement> {
  const stations = useRef<HTMLElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads neither value — they are the triggers, since the lit station is found in the DOM rather than passed in
  useEffect(() => {
    const el = stations.current;
    if (!el) return;
    // A frame later: the rail's own layout (collapse width, drawer transform) has not
    // necessarily settled when this render commits.
    const frame = requestAnimationFrame(() => exposeActiveStation(el));
    return () => cancelAnimationFrame(frame);
  }, [pathname, drawerOpen]);

  return stations;
}
