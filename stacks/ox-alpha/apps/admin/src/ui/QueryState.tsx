import type { ReactNode } from "react";

// Shared loading, error, and empty states (`components/QueryState.tsx`,
// `Skeleton.tsx` at the pinned commit). One component so every Car and Boat
// page announces data state identically, with stable test hooks.

export interface QueryStateProps {
  readonly loading: boolean;
  readonly error: boolean;
  readonly empty: boolean;
  readonly testIdPrefix: string;
  readonly emptyText: string;
  /** Optional skeleton rows shown instead of the bare loading line. */
  readonly skeleton?: boolean;
  readonly children?: ReactNode;
}

export function QueryState({
  loading,
  error,
  empty,
  testIdPrefix,
  emptyText,
  skeleton = false,
  children,
}: QueryStateProps) {
  return (
    <>
      {error && (
        <div
          className="card notice notice--error"
          role="alert"
          data-testid={`${testIdPrefix}-error`}
        >
          The local API could not be reached. The page will retry automatically.
        </div>
      )}
      {loading && !error && (
        <p
          className={skeleton ? "card skeleton muted" : "card muted"}
          aria-live="polite"
          data-testid={`${testIdPrefix}-loading`}
        >
          Loading…
        </p>
      )}
      {empty && !loading && !error && (
        <div className="card empty car-empty" data-testid={`${testIdPrefix}-empty`}>
          <strong>No matching data.</strong>
          <span>{emptyText}</span>
        </div>
      )}
      {!loading && !empty && children}
    </>
  );
}
