import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionNode } from "@claude-proxy/core";
import type { SessionGraphEntry } from "../api";
import { getSessionsGraph } from "../api";
import { fmtInt, fmtLocalTsShort } from "../format";

/**
 * Live session graph — one session at a time, its appended steps (task / decision /
 * tool / error / done) chained into a snake so a long run folds onto the screen
 * instead of running off the right. Rows-per-fold adapt to the viewport (mobile
 * flows top-to-bottom, desktop uses long rows). A collapsible left rail switches
 * sessions; the toolbar floats above the canvas. Polls so new steps stream in.
 */

// Layout geometry, in canvas px (pre-transform).
const ROOT_W = 224;
const ROOT_H = 96;
const NODE_W = 168;
const NODE_H = 64;
const CELL_W = ROOT_W; // uniform grid cell; boxes are centered within it
const CELL_H = ROOT_H;
const GAP_X = 44;
const GAP_Y = 58;
const PAD = 64;

/** Type → CSS color token, used for a node's glow and its incoming edge. */
const NODE_COLOR: Record<SessionNode["type"] | "root", string> = {
  task: "var(--signal)",
  decision: "var(--muted)",
  tool: "var(--amber)",
  error: "var(--coral)",
  done: "var(--good)",
  root: "var(--signal-dim)",
};

const LEGEND: { type: SessionNode["type"]; label: string }[] = [
  { type: "task", label: "task" },
  { type: "decision", label: "decision" },
  { type: "tool", label: "tool" },
  { type: "error", label: "error" },
  { type: "done", label: "done" },
];

/** Total color lookup (indexing is `string | undefined` under noUncheckedIndexedAccess). */
const color = (type: SessionNode["type"] | "root"): string => NODE_COLOR[type] ?? "var(--signal)";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Rows-per-fold from the viewport width: 1 = vertical (mobile), more = longer rows. */
function colsForWidth(w: number): number {
  if (w < 700) return 1;
  if (w < 1024) return 3;
  if (w < 1440) return 5;
  return 7;
}

/** A placed box on the canvas plus the data behind it (node is null for a session root). */
interface Box {
  key: string;
  kind: "root" | "node";
  x: number;
  y: number;
  w: number;
  h: number;
  entry: SessionGraphEntry;
  node: SessionNode | null;
}

interface Edge {
  key: string;
  d: string;
  color: string;
}

interface Selection {
  entry: SessionGraphEntry;
  node: SessionNode | null;
}

interface View {
  x: number;
  y: number;
  k: number;
}

/** Horizontal S-curve between two box edges (used within a snake row). */
function edgePathH(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

/** Vertical S-curve between two box edges (used at a snake's turn onto the next row). */
function edgePathV(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

/** Grid cell (row + left-to-right column) for the i-th item in a boustrophedon snake. */
function cell(i: number, cols: number) {
  const row = Math.floor(i / cols);
  const posInRow = i % cols;
  const leftToRight = row % 2 === 0;
  const col = leftToRight ? posInRow : cols - 1 - posInRow;
  return { row, col };
}

/** Snake layout for a single session: root then its steps fold across `cols` per row. */
function layout(entry: SessionGraphEntry | null, cols: number) {
  const boxes: Box[] = [];
  const edges: Edge[] = [];
  if (!entry) return { boxes, edges, contentW: 0, contentH: 0 };

  const items: { kind: "root" | "node"; node: SessionNode | null }[] = [
    { kind: "root", node: null },
    ...entry.nodes.map((node) => ({ kind: "node" as const, node })),
  ];

  let maxRight = PAD;
  let maxBottom = PAD;

  items.forEach((it, i) => {
    const { row, col } = cell(i, cols);
    const cellX = PAD + col * (CELL_W + GAP_X);
    const cellY = PAD + row * (CELL_H + GAP_Y);
    const w = it.kind === "root" ? ROOT_W : NODE_W;
    const h = it.kind === "root" ? ROOT_H : NODE_H;
    const x = cellX + (CELL_W - w) / 2;
    const y = cellY + (CELL_H - h) / 2;
    const key = it.kind === "root" ? `r:${entry.threadId}` : `${entry.threadId}:${it.node!.index}`;
    boxes.push({ key, kind: it.kind, x, y, w, h, entry, node: it.node });
    maxRight = Math.max(maxRight, cellX + CELL_W);
    maxBottom = Math.max(maxBottom, cellY + CELL_H);
  });

  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!;
    const b = boxes[i + 1]!;
    const ra = cell(i, cols).row;
    const rb = cell(i + 1, cols).row;
    const stroke = color(b.node ? b.node.type : "root");
    let d: string;
    if (ra === rb) {
      // Within a row — connect the facing horizontal edges, whichever way the row runs.
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      d = a.x < b.x ? edgePathH(a.x + a.w, ay, b.x, by) : edgePathH(a.x, ay, b.x + b.w, by);
    } else {
      // Turning onto the next row — drop from one box's bottom to the next's top.
      d = edgePathV(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y);
    }
    edges.push({ key: `e:${entry.threadId}:${i}`, d, color: stroke });
  }

  return { boxes, edges, contentW: maxRight + PAD, contentH: maxBottom + PAD };
}

/** Node style carries its glow color via the `--gc` custom property. */
function boxStyle(box: Box): CSSProperties {
  const glow = box.kind === "root" ? color("root") : color(box.node!.type);
  return { left: box.x, top: box.y, width: box.w, height: box.h, "--gc": glow } as CSSProperties;
}

function nodeLabel(node: SessionNode): string {
  if (node.type === "tool" && node.tool) return node.tool;
  return node.text || node.type;
}

export function SessionGraphPage() {
  const query = useQuery({ queryKey: ["sessions-graph"], queryFn: getSessionsGraph, refetchInterval: 4000 });
  const all = useMemo(() => query.data?.sessions ?? [], [query.data]);

  // Which session is on the canvas. Sessions arrive newest-first, so default to the head.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (all.length === 0) return;
    setSelectedId((prev) => (prev && all.some((s) => s.threadId === prev) ? prev : all[0]!.threadId));
  }, [all]);
  const entry = useMemo(() => all.find((s) => s.threadId === selectedId) ?? null, [all, selectedId]);

  const [cols, setCols] = useState(7);
  const { boxes, edges, contentW, contentH } = useMemo(() => layout(entry, cols), [entry, cols]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !contentW || !contentH) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const margin = 56;
    const k = clamp(Math.min((rect.width - margin * 2) / contentW, (rect.height - margin * 2) / contentH), 0.12, 1.4);
    setView({ x: (rect.width - contentW * k) / 2, y: (rect.height - contentH * k) / 2, k });
  }, [contentW, contentH]);

  // Refit only when the session or fold width changes — not on every poll, or streaming
  // steps would keep yanking the view back. `fitRef` keeps the effect off `fit`'s deps.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const id = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(id);
  }, [selectedId, cols]);

  // Track the viewport width to pick rows-per-fold (mobile → vertical, desktop → long rows).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCols(colsForWidth(el.clientWidth)));
    ro.observe(el);
    setCols(colsForWidth(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // Wheel zoom about the cursor (native listener so we can preventDefault).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const k = clamp(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 3);
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Track fullscreen (Esc exits natively; sync our flag and refit to the new size).
  useEffect(() => {
    const onChange = () => {
      setIsFull(document.fullscreenElement === viewportRef.current);
      requestAnimationFrame(() => fitRef.current());
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Esc closes the inspector when we're not in fullscreen (there Esc exits fullscreen instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const zoomBy = (factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    setView((v) => {
      const k = clamp(v.k * factor, 0.1, 3);
      return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
    });
  };

  const toggleFull = () => {
    const el = viewportRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  };

  const selectSession = (id: string) => {
    setSelectedId(id);
    setSelected(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest(".gnode") || t.closest(".graph-toolbar") || t.closest(".graph-inspector") || t.closest(".graph-sessions"))
      return;
    pan.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  };
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    pan.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  // Dot grid pans and scales with the view.
  const dot = 22 * view.k;
  const viewportStyle: CSSProperties = {
    backgroundSize: `${dot}px ${dot}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
  };
  const canvasStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` };

  return (
    <section className="graph-page">
      <div
        ref={viewportRef}
        className={`graph-viewport${isFull ? " is-full" : ""}${dragging ? " is-dragging" : ""}`}
        style={viewportStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div className="graph-canvas" style={canvasStyle}>
          <svg className="graph-edges" width={contentW} height={contentH} aria-hidden>
            {edges.map((e) => (
              <path key={e.key} className="graph-edge" d={e.d} style={{ stroke: e.color }} />
            ))}
          </svg>

          {boxes.map((box) =>
            box.kind === "root" ? (
              <button
                key={box.key}
                type="button"
                className={`gnode gnode--root${selected?.entry.threadId === box.entry.threadId && !selected?.node ? " is-selected" : ""}`}
                style={boxStyle(box)}
                onClick={() => setSelected({ entry: box.entry, node: null })}
              >
                <span className="gnode-kind">session</span>
                <span className="gnode-title" title={box.entry.firstTask ?? box.entry.threadId}>
                  {box.entry.firstTask ?? box.entry.threadId}
                </span>
                <span className="gnode-sub mono">
                  {box.entry.threadId.slice(0, 8)} · {box.entry.model ?? "—"}
                </span>
                <span className="gnode-chips">
                  <span>{fmtInt(box.entry.nodes.length)} steps</span>
                  {box.entry.errors > 0 ? <span className="gchip-error">{fmtInt(box.entry.errors)} err</span> : null}
                </span>
              </button>
            ) : (
              <button
                key={box.key}
                type="button"
                className={`gnode gnode--${box.node!.type}${selected?.node && selected.entry.threadId === box.entry.threadId && selected.node.index === box.node!.index ? " is-selected" : ""}`}
                style={boxStyle(box)}
                onClick={() => setSelected({ entry: box.entry, node: box.node })}
              >
                <span className="gnode-kind">{box.node!.type}</span>
                <span className="gnode-title" title={nodeLabel(box.node!)}>
                  {nodeLabel(box.node!)}
                </span>
              </button>
            ),
          )}
        </div>

        <SessionNav
          sessions={all}
          selectedId={selectedId}
          collapsed={navCollapsed}
          onSelect={selectSession}
          onToggle={() => setNavCollapsed((c) => !c)}
        />

        <div className="graph-toolbar">
          <span className="graph-status">
            <span className={`glive${query.isFetching ? " is-live" : ""}`} aria-hidden />
            {fmtInt(all.length)} sessions
            {entry ? <span className="muted"> · {fmtInt(entry.nodes.length)} steps</span> : null}
          </span>
          <div className="graph-btns">
            <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
              −
            </button>
            <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={fit}>
              Fit
            </button>
            <button type="button" onClick={toggleFull}>
              {isFull ? "Exit" : "Fullscreen"}
            </button>
          </div>
          <div className="graph-legend">
            {LEGEND.map((l) => (
              <span key={l.type} className="glegend-item">
                <span className="glegend-dot" style={{ background: color(l.type) }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>

        {query.error ? <div className="graph-note error">Failed to load: {(query.error as Error).message}</div> : null}
        {!query.isLoading && all.length === 0 ? <div className="graph-note muted">No session transcripts yet.</div> : null}

        <Inspector selection={selected} onClose={() => setSelected(null)} />
      </div>
    </section>
  );
}

/** Left rail listing every session; fixed over the canvas, collapses to a peek strip. */
function SessionNav({
  sessions,
  selectedId,
  collapsed,
  onSelect,
  onToggle,
}: {
  sessions: SessionGraphEntry[];
  selectedId: string | null;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggle: () => void;
}) {
  return (
    <aside className={`graph-sessions${collapsed ? " is-collapsed" : ""}`} aria-label="Sessions">
      <div className="gs-head">
        <span className="gs-title">Sessions</span>
        <button type="button" className="gs-collapse" onClick={onToggle} aria-label={collapsed ? "Pin open" : "Collapse"}>
          {collapsed ? "»" : "«"}
        </button>
      </div>
      <div className="gs-list">
        {sessions.map((s) => (
          <button
            key={s.threadId}
            type="button"
            className={`gs-item${s.threadId === selectedId ? " is-active" : ""}`}
            onClick={() => onSelect(s.threadId)}
          >
            <span className="gs-item-title">{s.firstTask ?? s.threadId}</span>
            <span className="gs-item-meta mono">
              {fmtLocalTsShort(s.modified)} · {fmtInt(s.nodes.length)} steps
              {s.errors > 0 ? <span className="gs-item-err"> · {fmtInt(s.errors)} err</span> : null}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function Inspector({ selection, onClose }: { selection: Selection | null; onClose: () => void }) {
  if (!selection) return null;
  const { entry, node } = selection;
  const kindColor = node ? color(node.type) : color("root");

  return (
    <aside className="graph-inspector" aria-label="Node details">
      <div className="gi-head">
        <span className="gi-kind" style={{ "--gc": kindColor } as CSSProperties}>
          {node ? node.type : "session"}
        </span>
        <button type="button" className="gi-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="gi-body">
        {node ? (
          <>
            {node.task ? <Field label="Task">{node.task}</Field> : null}
            {node.tool ? (
              <Field label="Tool">
                <code className="mono-break">{node.tool}</code>
              </Field>
            ) : null}
            <Field label="Detail">
              <p className="gi-text">{node.text || "—"}</p>
            </Field>
            <Field label="Step">#{node.index}</Field>
          </>
        ) : (
          <>
            <Field label="First task">{entry.firstTask ?? "—"}</Field>
            <div className="gi-stats">
              <Stat label="tasks" value={entry.tasks} />
              <Stat label="tools" value={entry.tools} />
              <Stat label="errors" value={entry.errors} tone={entry.errors > 0 ? "bad" : undefined} />
            </div>
          </>
        )}
        <Field label="Session">
          <span className="mono-break">{entry.threadId}</span>
        </Field>
        <Field label="Model">{entry.model ?? "—"}</Field>
        {entry.started ? <Field label="Started">{fmtLocalTsShort(entry.started)}</Field> : null}
        <Field label="Updated">{fmtLocalTsShort(entry.modified)}</Field>
        <Link to="/sessions/$id" params={{ id: entry.threadId }} className="link gi-open">
          Open transcript →
        </Link>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gi-field">
      <span className="gi-label">{label}</span>
      <div className="gi-value">{children}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className="gi-stat">
      <span className={`gi-stat-value${tone === "bad" ? " gi-stat-bad" : ""}`}>{fmtInt(value)}</span>
      <span className="gi-stat-label">{label}</span>
    </div>
  );
}
