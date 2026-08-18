import type { ReactNode } from 'react';
import { SkeletonStatus } from './Skeleton';

export interface QueryStateProps {
  isLoading: boolean;
  error: unknown;
  /**
   * Placeholder shown in the content's place on the first load. Without one the view
   * falls back to a line of text.
   */
  skeleton?: ReactNode;
  /**
   * Content already on screen but superseded: it stays put and dims. Pass a boolean
   * from the first render, never conditionally, or the subtree is remounted.
   */
  busy?: boolean;
  children: ReactNode;
}

/** Uniform loading / error framing for a query-backed view. */
export function QueryState({ isLoading, error, skeleton, busy, children }: QueryStateProps) {
  if (isLoading) {
    if (!skeleton) return <p className='muted state'>Loading…</p>;
    // No wrapper: some callers drop the skeleton straight into a flex container.
    return (
      <>
        <SkeletonStatus />
        {skeleton}
      </>
    );
  }
  // React Query hands back an `Error`; anything else reaching here is a thrown non-Error,
  // and naming it is still better than the blank the old assertion produced.
  if (error)
    return <p className='error state'>Failed to load: {error instanceof Error ? error.message : String(error)}</p>;
  if (busy === undefined) return <>{children}</>;
  return (
    <div className={busy ? 'is-stale' : undefined} aria-busy={busy || undefined}>
      {children}
    </div>
  );
}
