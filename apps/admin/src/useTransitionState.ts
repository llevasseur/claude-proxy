import { type SetStateAction, useCallback, useState, useTransition } from "react";

/**
 * State whose *re-render* is the expensive part: a table re-sorting thousands of
 * rows, a transcript flipping between rendered Markdown and raw JSON, a chart window
 * widening from 7 days to 30.
 *
 * The update runs inside `startTransition`, so React keeps the current screen
 * interactive and swaps it once the new one is ready, rather than blocking on the
 * click that asked for it. `isPending` is true while that render is in flight, and it
 * is what dims the outgoing content instead of replacing it with a skeleton — the
 * content is already on screen, so it stays in place and is simply superseded.
 *
 * `isPending` covers rendering only. Switching a data window also refetches, and that
 * half is the query's own `isFetching`; pages that switch windows pass both.
 */
export function useTransitionState<T>(initial: T): [T, (next: SetStateAction<T>) => void, boolean] {
  const [value, setValue] = useState(initial);
  const [isPending, startTransition] = useTransition();

  // `startTransition` is stable for the life of the component, so this setter is too
  // and can be handed to memoised children.
  const set = useCallback((next: SetStateAction<T>) => {
    startTransition(() => setValue(next));
  }, []);

  return [value, set, isPending];
}
