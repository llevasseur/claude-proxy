import type { ReactNode } from "react";
import { SkeletonStatus } from "./Skeleton";

export interface QueryStateProps {
  isLoading: boolean;
  error: unknown;
  /**
   * Placeholder shaped like the content, shown in its place on the first load. It
   * reserves the boxes the content will fill, so nothing moves when the data lands.
   * Without one the view falls back to a line of text.
   */
  skeleton?: ReactNode;
  /**
   * The content is already on screen but superseded — a transition is re-rendering
   * it, or the next window is being fetched behind it. It stays put and dims instead
   * of reverting to a skeleton. Pass it as a boolean from the first render (never
   * conditionally) so the wrapper is stable and the subtree is not remounted.
   */
  busy?: boolean;
  children: ReactNode;
}

/** Uniform loading / error framing for a query-backed view. */
export function QueryState({ isLoading, error, skeleton, busy, children }: QueryStateProps) {
  if (isLoading) {
    if (!skeleton) return <p className="muted state">Loading…</p>;
    // Announced once, then rendered without a wrapper: the skeleton stands in the
    // content's own place, and some callers drop it straight into a flex container.
    return (
      <>
        <SkeletonStatus />
        {skeleton}
      </>
    );
  }
  if (error) return <p className="error state">Failed to load: {(error as Error).message}</p>;
  if (busy === undefined) return <>{children}</>;
  return (
    <div className={busy ? "is-stale" : undefined} aria-busy={busy || undefined}>
      {children}
    </div>
  );
}
