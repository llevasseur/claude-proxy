import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/* At or below this width the rail is an off-canvas drawer. */
const DRAWER = '(max-width: 860px)';

let query: MediaQueryList | null = null;
function drawerQuery(): MediaQueryList {
  query ??= window.matchMedia(DRAWER);
  return query;
}

function subscribe(onChange: () => void): () => void {
  const mql = drawerQuery();
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export type NavDrawer = {
  /** The viewport is narrow enough that the rail is a drawer. */
  drawer: boolean;
  /** The drawer is showing — always false while the rail has its own column. */
  open: boolean;
  toggle: () => void;
  close: () => void;
};

/** Open state for the narrow-viewport nav drawer; widening back to a column closes it. */
export function useNavDrawer(): NavDrawer {
  const drawer = useSyncExternalStore(
    subscribe,
    () => drawerQuery().matches,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);

  const showing = drawer && open;
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showing]);

  return { drawer, open: showing, toggle, close };
}
