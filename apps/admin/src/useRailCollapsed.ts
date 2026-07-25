import { useCallback, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "admin:rail-collapsed";
/* Below this width the rail is a top bar, so collapsing does not apply. */
const COLLAPSIBLE = "(min-width: 861px)";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let query: MediaQueryList | null = null;
function collapsibleQuery(): MediaQueryList {
  query ??= window.matchMedia(COLLAPSIBLE);
  return query;
}

function subscribe(onChange: () => void): () => void {
  const mql = collapsibleQuery();
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Collapsed state for the side rail, persisted in `localStorage`. */
export function useRailCollapsed(): [boolean, () => void] {
  const [stored, setStored] = useState(readStored);
  const collapsible = useSyncExternalStore(
    subscribe,
    () => collapsibleQuery().matches,
    () => false,
  );

  const toggle = useCallback(() => {
    const next = !stored;
    setStored(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore — the toggle stays session-only */
    }
  }, [stored]);

  return [stored && collapsible, toggle];
}
