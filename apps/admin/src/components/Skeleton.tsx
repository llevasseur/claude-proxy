import type { CSSProperties, ReactNode } from "react";

/**
 * Loading placeholders that stand in the loaded content's own boxes.
 *
 * Every shape here is built from the classes the real page uses — `.card`,
 * `.card.stat`, `.table`, `.grid.stats` — with the shimmer placed *inside* those
 * elements rather than replacing them. Each block is an inline-block, so the real
 * element's own strut still sets the line box: a skeleton `.stat-value` is exactly
 * as tall as a filled one without either side hardcoding a pixel height. The
 * container is therefore already the size the content needs, and data arrives in
 * place instead of pushing the page around.
 *
 * The shapes take their row/card counts from the caller because that count is what
 * fixes the height — a page asks for what it typically shows.
 */

/** A CSS length: a number is px, a string is passed through. */
type Len = number | string;

const len = (v: Len | undefined): string | undefined => (typeof v === "number" ? `${v}px` : v);

/** Cycled so a paragraph of placeholders reads as written text, not as ruled lines. */
const LINE_WIDTHS = ["100%", "92%", "97%", "88%"];

export interface SkeletonProps {
  /** Width within its container. Defaults to filling it. */
  w?: Len;
  /** Height. Defaults to `0.72em`, which tracks the container's font size. */
  h?: Len;
  className?: string;
}

/**
 * One shimmering block. Decorative — the page announces its own load once, through
 * `SkeletonStatus`, so these stay out of the accessibility tree.
 */
export function Skeleton({ w, h, className }: SkeletonProps) {
  const style: CSSProperties = { width: len(w), height: len(h) };
  return <span className={className ? `skeleton ${className}` : "skeleton"} style={style} aria-hidden />;
}

/** Placeholder prose. The last line is short, the way a real paragraph ends. */
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
 * The one thing a screen reader hears while a page loads. Absolutely positioned, so
 * it can be dropped into a grid or flex container without becoming an item in it.
 */
export function SkeletonStatus({ label = "Loading" }: { label?: string }) {
  return (
    <span className="sr-only" role="status">
      {label}
    </span>
  );
}

/** A `.grid.stats` row of stat cards, matching the tiles the page will fill in. */
export function SkeletonStats({ count = 4 }: { count?: number }) {
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
}

/** A `.table` of placeholder rows, for dropping inside a card the page already draws. */
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
                <Skeleton w={c.cell ?? "78%"} />
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

/** A table in its own card — the shape most list pages load into. */
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
 * A chart card. `height` is the real chart's own fixed height (220 by default, the
 * `SeriesLineChart` default), so the plot area does not resize when data lands.
 */
export function SkeletonChartCard({
  title,
  height = 220,
  bars = 14,
}: {
  title?: string;
  height?: number;
  bars?: number;
}) {
  // A deterministic sawtooth: enough shape to read as a chart, no randomness to
  // make it flicker between renders.
  const heights = Array.from({ length: bars }, (_, i) => 34 + ((i * 37) % 61));

  return (
    <SkeletonCard title={title} head={title === undefined}>
      <div className="skeleton-chart" style={{ height }} aria-hidden>
        {heights.map((h, i) => (
          <span className="skeleton skeleton-bar" key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
    </SkeletonCard>
  );
}

/** A card of placeholder prose — for pages whose content is text rather than rows. */
export function SkeletonTextCard({ title, lines = 4 }: { title?: string; lines?: number }) {
  return (
    <SkeletonCard title={title} head={title === undefined}>
      <SkeletonText lines={lines} />
    </SkeletonCard>
  );
}

/**
 * `.msg-blocks` sections — the labelled blocks the message, tool-schema and error
 * pages render their content into.
 */
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

/**
 * A stack of card-shaped placeholders, for the advice and bucket lists. `lines`
 * sets how much prose each card reserves.
 */
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
