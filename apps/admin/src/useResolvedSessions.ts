import { useCallback, useState } from 'react';
import type { SessionSummary } from './api';

const STORAGE_KEY = 'admin:resolved-sessions';

/** Thread id → the ISO instant it was marked, for each of the two marks. */
interface Marks {
  /** When the reader filed it away. A turn after this instant un-files it. */
  resolved: Record<string, string>;
  /** When the reader pulled it back — the sort key that floats it to the top of Active. */
  restored: Record<string, string>;
}

const EMPTY: Marks = { resolved: {}, restored: {} };

function read(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Marks>;
    return { resolved: parsed.resolved ?? {}, restored: parsed.restored ?? {} };
  } catch {
    return EMPTY;
  }
}

function write(marks: Marks): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    /* ignore — the marks stay session-only */
  }
}

export interface ResolvedSessions {
  /** True while the session belongs in Resolved: filed away, and quiet ever since. */
  isResolved: (session: SessionSummary) => boolean;
  /** What Active sorts on — the session's last turn, or when it was pulled back. */
  activeAt: (session: SessionSummary) => number;
  resolve: (threadId: string) => void;
  restore: (threadId: string) => void;
}

/**
 * Which sessions the reader has filed away, persisted in `localStorage`.
 *
 * The mark carries a timestamp rather than being a flag: it only holds while the transcript
 * has been quiet since it was made, so a session that takes another turn returns to Active.
 */
export function useResolvedSessions(): ResolvedSessions {
  const [marks, setMarks] = useState<Marks>(read);

  const set = useCallback((next: Marks) => {
    setMarks(next);
    write(next);
  }, []);

  const isResolved = useCallback(
    (session: SessionSummary) => {
      const mark = marks.resolved[session.threadId];
      return !!mark && Date.parse(session.modified) <= Date.parse(mark);
    },
    [marks],
  );

  const activeAt = useCallback(
    (session: SessionSummary) => {
      const restored = marks.restored[session.threadId];
      const modified = Date.parse(session.modified);
      return restored ? Math.max(modified, Date.parse(restored)) : modified;
    },
    [marks],
  );

  const resolve = useCallback(
    (threadId: string) => {
      const { [threadId]: _dropped, ...restored } = marks.restored;
      set({ resolved: { ...marks.resolved, [threadId]: new Date().toISOString() }, restored });
    },
    [marks, set],
  );

  const restore = useCallback(
    (threadId: string) => {
      const { [threadId]: _dropped, ...resolved } = marks.resolved;
      set({ resolved, restored: { ...marks.restored, [threadId]: new Date().toISOString() } });
    },
    [marks, set],
  );

  return { isResolved, activeAt, resolve, restore };
}
