import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "admin:rail-collapsed";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Collapsed/expanded state for the side rail, persisted in `localStorage`. */
export function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore — the toggle stays session-only */
    }
  }, [collapsed]);

  return [collapsed, useCallback(() => setCollapsed((c) => !c), [])];
}
