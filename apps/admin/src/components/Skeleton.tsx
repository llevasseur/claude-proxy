import type { CSSProperties, ReactNode } from "react";
import { SPARKLINE_HEIGHT } from "./Sparkline";

/**
 * Loading placeholders built from the classes the real page uses — `.card`,
 * `.card.stat`, `.table`, `.grid.stats` — with the shimmer placed *inside* those
 * elements rather than replacing them. Each block is an inline-block, so the real
 * element's strut still sets the line box and no pixel heights are hardcoded.
 * Row and card counts come from the caller.
 */

/** A CSS length: a number is px, a string is passed through. */
type Len = number | string;

const len = (v: Len | undefined): string | undefined => (typeof v === "number" ? `${v}px` : v);

/** Cycled so placeholder prose reads as text rather than ruled lines. */
const LINE_WIDTHS = ["100%", "92%", "97%", "88%"];

export interface SkeletonProps {
  /** Width within its container. Defaults to filling it. */
  w?: Len;
  /** Height. Defaults to `0.72em`, tracking the container's font size. */
  h?: Len;
  className?: string;
}

/** One shimmering block. Decorative — `SkeletonStatus` carries the announcement. */
export function Skeleton({ w, h, className }: SkeletonProps) {
  const style: CSSProperties = { width: len(w), height: len(h) };
  return <span className={className ? `skeleton ${className}` : "skeleton"} style={style} aria-hidden />;
}

/** Placeholder prose, ending on a short line. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-text" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={i === lines - 1 ? "62%" : (LINE_WIDTHS[i % LINE_WIDTHS.length] ?? "100%")} />
      ))}
    </div>
  );
}

/**
 * Placeholder prose inside the real paragraph element, so that paragraph's own font
 * size, line height and margin reserve the space rather than a guess at them. Each
 * block fills its line, so one block is one rendered line.
 */
export function SkeletonNote({ lines = 3, className }: { lines?: number; className: string }) {
  return (
    <p className={className} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={i === lines - 1 ? "62%" : (LINE_WIDTHS[i % LINE_WIDTHS.length] ?? "100%")} />
      ))}
    </p>
  );
}

/**
 * The one thing a screen reader hears while a page loads. Absolutely positioned, so
 * it can sit in a grid or flex container without becoming an item in it.
 */
export function SkeletonStatus({ label = "Loading" }: { label?: string }) {
  return (
    <span className="sr-only" role="status">
      {label}
    </span>
  );
}

/** A `.grid.stats` row of stat cards. `spark` reserves the mini chart a card can carry. */
export function SkeletonStats({ count = 4, spark = false }: { count?: number; spark?: boolean }) {
  return (
    <div className="grid stats" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="card stat" key={i}>
          <div className="stat-label">
            <Skeleton w="60%" />
          </div>
          <div className="stat-value">
            <Skeleton w="72%" />
          </div>
          <div className="stat-foot">
            <Skeleton w="46%" />
          </div>
          {spark && (
            <div className="sparkline" style={{ height: SPARKLINE_HEIGHT }}>
              <Skeleton h="100%" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** One column of a placeholder table. */
export interface SkeletonColumn {
  /** The real column's class — `num` and `bar-col` set its alignment and width. */
  className?: string;
  /** Header cell width. */
  head?: Len;
  /** Body cell width. */
  cell?: Len;
  /**
   * Lines the real cell wraps to. A long label in a narrow column is what sets the
   * row's height, so reserving one line where the page renders three leaves the
   * table short by the difference on every row.
   */
  lines?: number;
}

/** A `.table` of placeholder rows, for dropping inside a card. */
export function SkeletonTable({ columns, rows = 6 }: { columns: readonly SkeletonColumn[]; rows?: number }) {
  return (
    <table className="table" aria-hidden>
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i} className={c.className}>
              <Skeleton w={c.head ?? "68%"} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          <tr key={r}>
            {columns.map((c, i) => (
              <td key={i} className={c.className}>
                {Array.from({ length: c.lines ?? 1 }, (_, l) => (
                  <Skeleton key={l} w={l === 0 ? (c.cell ?? "78%") : "54%"} />
                ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A card whose heading is real text and whose body is still loading. */
export function SkeletonCard({ title, head, children }: { title?: string; head?: boolean; children: ReactNode }) {
  return (
    <div className="card">
      {title !== undefined ? <h2>{title}</h2> : head ? <Skeleton w="34%" className="skeleton-h2" /> : null}
      {children}
    </div>
  );
}

/** A table in its own card. */
export function SkeletonTableCard({
  title,
  columns,
  rows = 6,
}: {
  title?: string;
  columns: readonly SkeletonColumn[];
  rows?: number;
}) {
  return (
    <SkeletonCard title={title} head={title === undefined}>
      <SkeletonTable columns={columns} rows={rows} />
    </SkeletonCard>
  );
}

/**
 * A chart card. `height` must match the real chart's fixed height (`SeriesLineChart`
 * defaults to 220; a `BarChart` is `BAR_CHART_HEIGHT`). `legend` reserves that many
 * `.chartlegend` entries beneath the plot.
 */
export function SkeletonChartCard({
  title,
  height = 220,
  bars = 14,
  legend = 0,
}: {
  title?: string;
  height?: number;
  bars?: number;
  legend?: number;
}) {
  // Deterministic sawtooth, so the bars don't flicker between renders.
  const heights = Array.from({ length: bars }, (_, i) => 34 + ((i * 37) % 61));

  return (
    <SkeletonCard title={title} head={title === undefined}>
      <div className="skeleton-chart" style={{ height }} aria-hidden>
        {heights.map((h, i) => (
          <span className="skeleton skeleton-bar" key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
      {legend > 0 && (
        <div className="chartlegend" aria-hidden>
          {Array.from({ length: legend }, (_, i) => (
            <span className="chartlegend-item" key={i}>
              <Skeleton w="4.5rem" />
            </span>
          ))}
        </div>
      )}
    </SkeletonCard>
  );
}

/** A card of placeholder prose. */
export function SkeletonTextCard({ title, lines = 4 }: { title?: string; lines?: number }) {
  return (
    <SkeletonCard title={title} head={title === undefined}>
      <SkeletonText lines={lines} />
    </SkeletonCard>
  );
}

/** `.msg-blocks` sections, as used by the message, tool-schema and error pages. */
export function SkeletonMsgBlocks({ count = 3, lines = 4 }: { count?: number; lines?: number }) {
  return (
    <div className="msg-blocks" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="msg-block" key={i}>
          <div className="msg-block-head">
            <span className="msg-block-label">
              <Skeleton w="6rem" />
            </span>
          </div>
          <SkeletonText lines={lines} />
        </div>
      ))}
    </div>
  );
}

/** A stack of card-shaped placeholders; `lines` sets the prose each card reserves. */
export function SkeletonCardList({
  count = 3,
  lines = 2,
  className = "advice-list wide",
}: {
  count?: number;
  lines?: number;
  className?: string;
}) {
  return (
    <div className={className} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div className="card" key={i}>
          <Skeleton w="46%" className="skeleton-h2" />
          <SkeletonText lines={lines} />
        </div>
      ))}
    </div>
  );
}
