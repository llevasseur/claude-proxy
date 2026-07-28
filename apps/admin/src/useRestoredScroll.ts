import { useElementScrollRestoration } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/**
 * Re-apply the router's remembered scroll offset once an async page body is on screen.
 *
 * The router restores window scroll the moment the route renders, but a page whose body
 * arrives with a query is still its loading state at that point: the document is too short
 * to hold the old offset, so the browser clamps it away. Pass `ready` as the condition that
 * the real content is rendered and the offset lands for real. A first visit is a no-op —
 * the cache only holds an entry for a location being navigated back to.
 */
export function useRestoredScroll(ready: boolean): void {
  const entry = useElementScrollRestoration({ getElement: () => window });
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current || !ready || !entry) return;
    applied.current = true;
    if (window.scrollX === entry.scrollX && window.scrollY === entry.scrollY) return;
    window.scrollTo(entry.scrollX, entry.scrollY);
  }, [ready, entry]);
}
