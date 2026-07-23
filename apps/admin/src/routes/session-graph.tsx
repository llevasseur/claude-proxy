import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionNode } from "@claude-proxy/core";
import type { SessionGraphEntry } from "../api";
import { getSessionsGraph } from "../api";
import { fmtInt, fmtLocalTsShort } from "../format";

/**
 * Live session graph — a dot-grid canvas where each session is a root box and its
 * appended steps (task / decision / tool / error / done) chain off to the right as
 * type-colored node boxes. Polls the server so new steps stream in and animate on
 * mount. Pan/zoom/fit/fullscreen; clicking a node opens the inspector.
 */

// Layout geometry, in canvas px (pre-transform).
const ROOT_W = 224;
const ROOT_H = 96;
const NODE_W = 162;
const NODE_H = 62;
const GAP_X = 46;
const GAP_Y = 56;
const PAD = 56;
const ROW_PITCH = ROOT_H + GAP_Y;

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

/** A soft horizontal S-curve from one box's right edge to the next box's left edge. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

/** Deterministic left-to-right layout: one session per row, steps chained after its root. */
function layout(sessions: SessionGraphEntry[]) {
  const boxes: Box[] = [];
  const edges: Edge[] = [];
  let maxRight = PAD + ROOT_W;
  let maxBottom = PAD + ROOT_H;

  sessions.forEach((entry, i) => {
    const top = PAD + i * ROW_PITCH;
    const cy = top + ROOT_H / 2;
    boxes.push({ key: `r:${entry.threadId}`, kind: "root", x: PAD, y: top, w: ROOT_W, h: ROOT_H, entry, node: null });

    let prevRight = PAD + ROOT_W;
    entry.nodes.forEach((node, j) => {
      const x = PAD + ROOT_W + GAP_X + j * (NODE_W + GAP_X);
      boxes.push({ key: `${entry.threadId}:${node.index}`, kind: "node", x, y: cy - NODE_H / 2, w: NODE_W, h: NODE_H, entry, node });
      edges.push({ key: `e:${entry.threadId}:${j}`, d: edgePath(prevRight, cy, x, cy), color: color(node.type) });
      prevRight = x + NODE_W;
      maxRight = Math.max(maxRight, x + NODE_W);
    });
    maxBottom = Math.max(maxBottom, top + ROOT_H);
  });

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

  const [limit, setLimit] = useState(40);
  const sessions = useMemo(() => (limit >= 9999 ? all : all.slice(0, limit)), [all, limit]);
  const { boxes, edges, contentW, contentH } = useMemo(() => layout(sessions), [sessions]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const didFit = useRef(false);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !contentW || !contentH) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const margin = 48;
    const k = clamp(Math.min((rect.width - margin * 2) / contentW, (rect.height - margin * 2) / contentH), 0.12, 1.4);
    setView({ x: (rect.width - contentW * k) / 2, y: (rect.height - contentH * k) / 2, k });
  }, [contentW, contentH]);

  // Fit once, the first time any data lands.
  useEffect(() => {
    if (!didFit.current && boxes.length > 0) {
      didFit.current = true;
      fit();
    }
  }, [boxes.length, fit]);

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
      requestAnimationFrame(fit);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [fit]);

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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest(".gnode") || t.closest(".graph-toolbar") || t.closest(".graph-inspector")) return;
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
      <div className="pagehead">
        <h1>Live session graph</h1>
        <span className="muted">Every session as a node stream — new steps stream in live</span>
      </div>

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
                <span className="gnode-sub mono">{box.entry.threadId.slice(0, 8)} · {box.entry.model ?? "—"}</span>
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

        <div className="graph-toolbar">
          <span className="graph-status">
            <span className={`glive${query.isFetching ? " is-live" : ""}`} aria-hidden />
            {fmtInt(all.length)} sessions
            {sessions.length < all.length ? <span className="muted"> · {sessions.length} shown</span> : null}
          </span>
          <label className="graph-limit">
            show
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={20}>20</option>
              <option value={40}>40</option>
              <option value={100}>100</option>
              <option value={9999}>all</option>
            </select>
          </label>
          <div className="graph-btns">
            <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
            <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
            <button type="button" onClick={fit}>Fit</button>
            <button type="button" onClick={toggleFull}>{isFull ? "Exit" : "Fullscreen"}</button>
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
        {!query.isLoading && boxes.length === 0 ? <div className="graph-note muted">No session transcripts yet.</div> : null}

        <Inspector selection={selected} onClose={() => setSelected(null)} />
      </div>
    </section>
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
