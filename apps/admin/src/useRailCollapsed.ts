import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "admin:rail-collapsed";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Collapsed/expanded state for the side rail, persisted so the choice survives a reload
 * instead of resetting on every navigation. Storage failures (private mode, disabled
 * cookies) degrade to a session-only toggle rather than breaking the shell.
 * Returns the current state and a stable toggle.
 */
export function useRailCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore — the toggle still works for this session */
    }
  }, [collapsed]);

  return [collapsed, useCallback(() => setCollapsed((c) => !c), [])];
}
