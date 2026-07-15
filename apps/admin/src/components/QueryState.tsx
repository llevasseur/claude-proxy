import type { ReactNode } from "react";

export interface QueryStateProps {
  isLoading: boolean;
  error: unknown;
  children: ReactNode;
}

/** Uniform loading / error framing for a query-backed view. */
export function QueryState({ isLoading, error, children }: QueryStateProps) {
  if (isLoading) return <p className="muted state">Loading…</p>;
  if (error) return <p className="error state">Failed to load: {(error as Error).message}</p>;
  return <>{children}</>;
}
