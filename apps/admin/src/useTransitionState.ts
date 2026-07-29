import { type SetStateAction, useCallback, useState, useTransition } from "react";

/**
 * State whose *re-render* is the expensive part — a table re-sorting thousands of rows,
 * a transcript flipping between Markdown and raw JSON, a chart window widening.
 *
 * The update runs inside `startTransition`, so the current screen stays interactive and
 * is swapped once the new one is ready. `isPending` is true while that render is in
 * flight and is what dims the outgoing content.
 *
 * `isPending` covers rendering only. Switching a data window also refetches, and that
 * half is the query's own `isFetching`; pages that switch windows pass both.
 */
export function useTransitionState<T>(initial: T): [T, (next: SetStateAction<T>) => void, boolean] {
  const [value, setValue] = useState(initial);
  const [isPending, startTransition] = useTransition();

  // `startTransition` is stable, so this setter is too and can go to memoised children.
  const set = useCallback((next: SetStateAction<T>) => {
    startTransition(() => setValue(next));
  }, []);

  return [value, set, isPending];
}
