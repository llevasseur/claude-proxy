import { useCallback, useState } from 'react';

const STORAGE_KEY = 'admin:theme';

export type Theme = 'light' | 'dark';

/** The attribute the inline script in index.html set before first paint. */
function current(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Light/dark theme, persisted in `localStorage` and mirrored onto `<html data-theme>`. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);

  const toggle = useCallback(() => {
    const next: Theme = current() === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore — the choice stays session-only */
    }
    setTheme(next);
  }, []);

  return [theme, toggle];
}
