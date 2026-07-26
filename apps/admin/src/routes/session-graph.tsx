import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode, Ref } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionNode } from "@claude-proxy/core";
import { mergeSessionNodes, spawnAgentType } from "@claude-proxy/core";
import type { SessionGraphEntry } from "../api";
import { getSessionGraphNodes, getSessionsGraph } from "../api";
import { fmtInt, fmtLocalTsShort } from "../format";

/**
 * Live session graph — one session at a time, its appended steps (task / decision /
 * tool / error / done) chained into a snake so a long run folds onto the screen
 * instead of running off the right. Rows-per-fold adapt to the viewport (mobile
 * flows top-to-bottom, desktop uses long rows). A collapsible left rail switches
 * sessions; the toolbar floats above the canvas. Polls so new steps stream in.
 *
 * A subagent keeps its own transcript, so it draws as a branch: the parent's `Agent(…)`
 * step opens an indented band around the subagent's own snake, and a return edge carries
 * it back into the parent step its result flows into. The rail nests the same tree.
 *
 * The transcript only fixes *which* steps exist — it gists every line to 160 chars, so the
 * text itself comes from the canvased family's Request breakdown, where the same steps are
 * recorded whole.
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
/** A branch band's indent from its parent's left edge, its inner padding, and its label strip. */
const BAND_INSET = 40;
const BAND_PAD = 18;
const BAND_HEAD = 34;
/** Gap between a parent row and a branch band hanging beneath it. */
const BAND_GAP = 26;

/** Overlay panels with their own scrollbar; a collapsed rail has nothing to scroll. */
const SCROLLS_ITSELF = ".graph-sessions:not(.is-collapsed), .graph-inspector";

/** What a box or edge is about — drives its glow color. */
type Tone = SessionNode["type"] | "root" | "agent";

/** Tone → CSS color token. */
const NODE_COLOR: Record<Tone, string> = {
  task: "var(--signal)",
  decision: "var(--muted)",
  tool: "var(--amber)",
  error: "var(--coral)",
  done: "var(--good)",
  root: "var(--signal-dim)",
  agent: "var(--violet)",
};

const LEGEND: { tone: Tone; label: string }[] = [
  { tone: "task", label: "task" },
  { tone: "decision", label: "decision" },
  { tone: "tool", label: "tool" },
  { tone: "agent", label: "subagent" },
  { tone: "error", label: "error" },
  { tone: "done", label: "done" },
];

/** Total color lookup (indexing is `string | undefined` under noUncheckedIndexedAccess). */
const color = (tone: Tone): string => NODE_COLOR[tone] ?? "var(--signal)";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Rows-per-fold from the viewport width: 1 = vertical (mobile), more = longer rows. */
function colsForWidth(w: number): number {
  if (w < 700) return 1;
  if (w < 1024) return 3;
  if (w < 1440) return 5;
  return 7;
}

/** Harness-injected context, not the user's words — including a block cut off mid-way. */
const stripReminders = (s: string): string =>
  s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>[\s\S]*$/i, "")
    .trim();

/**
 * The most human name a transcript offers. Transcripts written before the proxy recorded
 * a reminder-free subtitle open with an injected context blob, so fall back to the first
 * task that says something.
 */
function entryLabel(entry: SessionGraphEntry): string {
  if (entry.title) return entry.title;
  if (entry.subtitle) return entry.subtitle;
  for (const node of entry.nodes) {
    if (node.type !== "task") continue;
    const text = stripReminders(node.text);
    if (text) return text;
  }
  return entry.threadId;
}

/** A subagent is still running while its parent hasn't taken a step past the spawn. */
const isInFlight = (entry: SessionGraphEntry): boolean => entry.parentThreadId !== null && entry.returnIndex === null;

/** A placed box on the canvas plus the data behind it (node is null for a session root). */
interface Box {
  key: string;
  /** `root` = the canvased session, `agent` = a subagent's own root, `node` = one step. */
  kind: "root" | "agent" | "node";
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
  /** `step` follows one session's chain; `spawn`/`return` cross into and out of a branch. */
  kind: "step" | "spawn" | "return";
}

/** The nested frame drawn around one subagent's branch. */
interface Band {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  entry: SessionGraphEntry;
  inFlight: boolean;
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

/** Vertical S-curve between two boxes, leaving whichever edge faces the other. */
function boxPathV(from: Box, to: Box): string {
  const above = to.y + to.h <= from.y;
  return edgePathV(from.x + from.w / 2, above ? from.y : from.y + from.h, to.x + to.w / 2, above ? to.y + to.h : to.y);
}

/** Grid cell (row + left-to-right column) for the i-th item in a boustrophedon snake. */
function cell(i: number, cols: number) {
  const row = Math.floor(i / cols);
  const posInRow = i % cols;
  const leftToRight = row % 2 === 0;
  const col = leftToRight ? posInRow : cols - 1 - posInRow;
  return { row, col };
}

/** Subagents indexed by the step that spawned them: parent thread id → spawn index → child. */
type ChildIndex = Map<string, Map<number, SessionGraphEntry>>;

function indexChildren(entries: SessionGraphEntry[]): ChildIndex {
  const index: ChildIndex = new Map();
  for (const entry of entries) {
    if (entry.parentThreadId === null || entry.spawnIndex === null) continue;
    const bySpawn = index.get(entry.parentThreadId) ?? new Map<number, SessionGraphEntry>();
    bySpawn.set(entry.spawnIndex, entry);
    index.set(entry.parentThreadId, bySpawn);
  }
  return index;
}

/** Subagents of one transcript, in spawn order. */
function childrenOf(index: ChildIndex, threadId: string): SessionGraphEntry[] {
  return [...(index.get(threadId)?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([, child]) => child);
}

interface Placed {
  boxes: Box[];
  edges: Edge[];
  bands: Band[];
  /** Rightmost / lowest canvas coordinate reached, so a caller can frame around it. */
  right: number;
  bottom: number;
}

/**
 * Snake one session from (`x0`, `y0`): its root box, then its steps folding every `cols`
 * boxes. A step that spawned a subagent hangs that subagent's own (recursive) layout
 * beneath its row as an indented band, and the rows below start under the band.
 */
function layoutTree(
  entry: SessionGraphEntry,
  cols: number,
  x0: number,
  y0: number,
  index: ChildIndex,
  depth: number,
): Placed {
  const items: { kind: Box["kind"]; node: SessionNode | null }[] = [
    { kind: depth === 0 ? "root" : "agent", node: null },
    ...entry.nodes.map((node) => ({ kind: "node" as const, node })),
  ];
  const spawned = index.get(entry.threadId);

  const boxes: Box[] = [];
  const edges: Edge[] = [];
  const bands: Band[] = [];
  let right = x0;
  let y = y0;

  const rows = Math.ceil(items.length / cols);
  for (let row = 0; row < rows; row++) {
    const rowTop = y;
    const from = row * cols;
    const to = Math.min(items.length, from + cols);

    for (let i = from; i < to; i++) {
      const it = items[i]!;
      const cellX = x0 + cell(i, cols).col * (CELL_W + GAP_X);
      const w = it.kind === "node" ? NODE_W : ROOT_W;
      const h = it.kind === "node" ? NODE_H : ROOT_H;
      boxes.push({
        key: it.node ? `${entry.threadId}:${it.node.index}` : `r:${entry.threadId}`,
        kind: it.kind,
        x: cellX + (CELL_W - w) / 2,
        y: rowTop + (CELL_H - h) / 2,
        w,
        h,
        entry,
        node: it.node,
      });
      right = Math.max(right, cellX + CELL_W);
    }
    y = rowTop + CELL_H;

    // Branch bands for any spawns that landed in this row, in spawn order.
    for (let i = from; i < to; i++) {
      const node = items[i]!.node;
      const child = node ? spawned?.get(node.index) : undefined;
      if (!child) continue;

      const bandTop = y + BAND_GAP;
      const inner = layoutTree(child, Math.max(1, cols - 1), x0 + BAND_INSET + BAND_PAD, bandTop + BAND_HEAD, index, depth + 1);
      const bandRight = inner.right + BAND_PAD;
      bands.push({
        key: `b:${child.threadId}`,
        x: x0 + BAND_INSET,
        y: bandTop,
        w: bandRight - (x0 + BAND_INSET),
        h: inner.bottom + BAND_PAD - bandTop,
        entry: child,
        inFlight: isInFlight(child),
      });
      bands.push(...inner.bands);
      boxes.push(...inner.boxes);
      edges.push(...inner.edges);
      right = Math.max(right, bandRight);
      y = inner.bottom + BAND_PAD;
    }
    y += GAP_Y;
  }

  // Chain this session's own boxes — nested ones were chained by the recursive call.
  const own = boxes.filter((b) => b.entry.threadId === entry.threadId);
  for (let i = 0; i < own.length - 1; i++) {
    const a = own[i]!;
    const b = own[i + 1]!;
    let d: string;
    if (cell(i, cols).row === cell(i + 1, cols).row) {
      // Within a row — connect the facing horizontal edges, whichever way the row runs.
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      d = a.x < b.x ? edgePathH(a.x + a.w, ay, b.x, by) : edgePathH(a.x, ay, b.x + b.w, by);
    } else {
      // Turning onto the next row — drop from one box's bottom to the next's top.
      d = edgePathV(a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y);
    }
    edges.push({ key: `e:${entry.threadId}:${i}`, d, color: color(boxTone(b)), kind: "step" });
  }

  return { boxes, edges, bands, right, bottom: Math.max(y0, y - GAP_Y) };
}

/**
 * Lay out the selected session with every subagent branch beneath it, then wire the
 * cross-session edges: spawn (parent step → subagent root) and return (the subagent's
 * last step → the parent step its result flows into). Those wait until every box is
 * placed, since a return can land on a row below the branch.
 */
function layout(entry: SessionGraphEntry | null, cols: number, index: ChildIndex) {
  if (!entry) return { boxes: [], edges: [], bands: [], contentW: 0, contentH: 0 };

  const placed = layoutTree(entry, cols, PAD, PAD, index, 0);
  const boxAt = new Map(placed.boxes.map((b) => [b.key, b]));
  const edges = [...placed.edges];

  for (const { entry: child } of placed.bands) {
    const spawn = boxAt.get(`${child.parentThreadId}:${child.spawnIndex}`);
    const root = boxAt.get(`r:${child.threadId}`);
    if (spawn && root) {
      edges.push({ key: `sp:${child.threadId}`, d: boxPathV(spawn, root), color: color("agent"), kind: "spawn" });
    }

    // The branch's last step back into the parent step it rejoins — absent while in flight.
    const lastNode = child.nodes[child.nodes.length - 1];
    const last = lastNode ? boxAt.get(`${child.threadId}:${lastNode.index}`) : root;
    const rejoin = child.returnIndex === null ? undefined : boxAt.get(`${child.parentThreadId}:${child.returnIndex}`);
    if (last && rejoin) {
      edges.push({ key: `rt:${child.threadId}`, d: boxPathV(last, rejoin), color: color("agent"), kind: "return" });
    }
  }

  return { ...placed, edges, contentW: placed.right + PAD, contentH: placed.bottom + PAD };
}

/** What a box is about: a session root, a subagent (its root or the step spawning it), or a step. */
function boxTone(box: Box): Tone {
  if (box.kind === "root") return "root";
  if (box.kind === "agent") return "agent";
  return spawnAgentType(box.node!) === null ? box.node!.type : "agent";
}

/** Node style carries its glow color via the `--gc` custom property. */
function boxStyle(box: Box): CSSProperties {
  return { left: box.x, top: box.y, width: box.w, height: box.h, "--gc": color(boxTone(box)) } as CSSProperties;
}

/** A spawn step is labelled by the kind of agent it started, not its raw signature. */
function nodeLabel(node: SessionNode): string {
  const agent = spawnAgentType(node);
  if (agent !== null) return agent || "subagent";
  if (node.type === "tool" && node.tool) return node.tool;
  return node.text || node.type;
}

const nodeKind = (node: SessionNode): string => (spawnAgentType(node) === null ? node.type : "spawn");

/** Untruncated step text runs to thousands of chars — a hover tooltip wants a peek, not all of it. */
function hoverLabel(node: SessionNode): string {
  const label = nodeLabel(node);
  return label.length > 300 ? `${label.slice(0, 299)}…` : label;
}

/** How often to re-read the family's captured requests — far heavier than a transcript poll. */
const NODES_REFETCH_MS = 20_000;

export function SessionGraphPage() {
  const query = useQuery({ queryKey: ["sessions-graph"], queryFn: getSessionsGraph, refetchInterval: 4000 });
  const transcripts = useMemo(() => query.data?.sessions ?? [], [query.data]);

  // Selection is resolved off the transcripts: laying the breakdown's text over them
  // changes no thread id and no parent link, so this stays a one-pass derivation.
  const byThread = useMemo(() => new Map(transcripts.map((s) => [s.threadId, s])), [transcripts]);

  /** Walk up to the top-level session a transcript belongs to — what the canvas draws. */
  const rootOf = useCallback(
    (id: string): string => {
      let at = id;
      for (let hops = 0; hops <= byThread.size; hops++) {
        const parent = byThread.get(at)?.parentThreadId;
        if (!parent || !byThread.has(parent)) return at;
        at = parent;
      }
      return at;
    },
    [byThread],
  );

  // Which session is on the canvas — always a top-level one, so picking a subagent
  // canvases its family. Sessions arrive newest-first, so default to the head's family.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (transcripts.length === 0) return;
    setSelectedId((prev) => rootOf(prev && byThread.has(prev) ? prev : transcripts[0]!.threadId));
  }, [transcripts, byThread, rootOf]);

  // The canvased family's steps, re-read from its captured requests so nothing is gisted.
  // Failure is silent by design: the transcript still draws the graph, just abbreviated.
  const nodesQuery = useQuery({
    queryKey: ["session-graph-nodes", selectedId],
    queryFn: () => getSessionGraphNodes(selectedId!),
    enabled: selectedId !== null,
    refetchInterval: NODES_REFETCH_MS,
  });
  const derived = useMemo(
    () => new Map((nodesQuery.data?.threads ?? []).map((t) => [t.threadId, t])),
    [nodesQuery.data],
  );
  /** Thread id → the captured request its steps were read from, for the inspector to link. */
  const sources = useMemo(() => new Map([...derived].map(([id, t]) => [id, t.file])), [derived]);

  const all = useMemo(
    () =>
      transcripts.map((e) => {
        const from = derived.get(e.threadId);
        return from ? { ...e, nodes: mergeSessionNodes(e.nodes, from.nodes) } : e;
      }),
    [transcripts, derived],
  );

  const byId = useMemo(() => new Map(all.map((s) => [s.threadId, s])), [all]);
  const childIndex = useMemo(() => indexChildren(all), [all]);
  const roots = useMemo(() => all.filter((s) => s.parentThreadId === null), [all]);
  const entry = useMemo(() => all.find((s) => s.threadId === selectedId) ?? null, [all, selectedId]);

  const [cols, setCols] = useState(7);
  const { boxes, edges, bands, contentW, contentH } = useMemo(() => layout(entry, cols, childIndex), [entry, cols, childIndex]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  /** Whether the details drawer is widened — sticky, so it survives picking another node. */
  const [inspectorWide, setInspectorWide] = useState(false);
  /** The branch to highlight and center, set by picking a subagent in the rail. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  /**
   * The slice of the viewport left free by the two overlays — the session rail on the left
   * and the details drawer on the right. Both sit *over* the canvas rather than shrinking
   * it, so their widths are measured live: each animates between states, the rail caps at a
   * share of narrow viewports, and the drawer is absent entirely when nothing is selected.
   * Kept from collapsing to nothing when a widened drawer all but fills a small viewport.
   */
  const freeArea = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const left = navRef.current?.getBoundingClientRect().width ?? 0;
    const right = inspectorRef.current?.getBoundingClientRect().width ?? 0;
    const width = Math.max(rect.width - left - right, Math.min(240, rect.width));
    return { left, width, height: rect.height };
  }, []);

  const fit = useCallback(() => {
    const area = freeArea();
    if (!area || area.width <= 0 || !contentW || !contentH) return;
    // Breathing room, dialled back when the rail leaves little to work with.
    const margin = Math.min(56, area.width / 8, area.height / 8);
    const k = clamp(Math.min((area.width - margin * 2) / contentW, (area.height - margin * 2) / contentH), 0.12, 1.4);
    setView({ x: area.left + (area.width - contentW * k) / 2, y: (area.height - contentH * k) / 2, k });
  }, [contentW, contentH, freeArea]);

  // Refit only when the session or fold width changes — not on every poll, or streaming
  // steps would keep yanking the view back. `fitRef` keeps the effect off `fit`'s deps.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const id = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(id);
  }, [selectedId, cols]);

  // Center a focused branch. Boxes come through a ref so a poll's new steps can't
  // re-center; only a fresh pick (or a re-fold) moves the view.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  useEffect(() => {
    if (!focusId) return;
    const id = requestAnimationFrame(() => {
      const area = freeArea();
      const box = boxesRef.current.find((b) => b.key === `r:${focusId}`);
      if (!area || !box) return;
      setView((v) => ({
        ...v,
        x: area.left + area.width / 2 - (box.x + box.w / 2) * v.k,
        y: area.height / 2 - (box.y + box.h / 2) * v.k,
      }));
    });
    return () => cancelAnimationFrame(id);
  }, [focusId, selectedId, cols, freeArea]);

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
      // The overlay panels sit inside the viewport, so their wheels bubble here.
      if ((e.target as HTMLElement).closest(SCROLLS_ITSELF)) return;
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

  /** Picking a session canvases it; picking a subagent canvases its family and centers that branch. */
  const selectSession = (picked: SessionGraphEntry) => {
    setSelectedId(rootOf(picked.threadId));
    setFocusId(picked.parentThreadId === null ? null : picked.threadId);
    setSelected(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (
      t.closest(".gnode") ||
      t.closest(".gband-head") ||
      t.closest(".graph-toolbar") ||
      t.closest(".graph-inspector") ||
      t.closest(".graph-sessions")
    )
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
  const flying = bands.filter((b) => b.inFlight).length;

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
          {/* Branch frames sit behind the edges and boxes they enclose. */}
          {bands.map((band) => (
            <div
              key={band.key}
              className={`gband${band.inFlight ? " is-flight" : ""}${focusId === band.entry.threadId ? " is-focus" : ""}`}
              style={{ left: band.x, top: band.y, width: band.w, height: band.h }}
            >
              <button type="button" className="gband-head" onClick={() => setSelected({ entry: band.entry, node: null })}>
                <span className="gband-kind">subagent</span>
                <span className="gband-type">{band.entry.agentType ?? "agent"}</span>
                <span className="gband-title">{entryLabel(band.entry)}</span>
                <span className={`gband-state${band.inFlight ? " is-flight" : ""}`}>
                  {band.inFlight ? "in flight" : "returned"}
                </span>
              </button>
            </div>
          ))}

          <svg className="graph-edges" width={contentW} height={contentH} aria-hidden>
            <defs>
              {/* Points a return edge at the parent step it lands on. */}
              <marker id="graph-return-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--violet)" />
              </marker>
            </defs>
            {edges.map((e) => (
              <path
                key={e.key}
                className={`graph-edge graph-edge--${e.kind}`}
                d={e.d}
                style={{ stroke: e.color }}
                markerEnd={e.kind === "return" ? "url(#graph-return-arrow)" : undefined}
              />
            ))}
          </svg>

          {boxes.map((box) =>
            box.kind === "node" ? (
              <button
                key={box.key}
                type="button"
                className={`gnode gnode--${boxTone(box)}${selected?.node && selected.entry.threadId === box.entry.threadId && selected.node.index === box.node!.index ? " is-selected" : ""}`}
                style={boxStyle(box)}
                onClick={() => setSelected({ entry: box.entry, node: box.node })}
              >
                <span className="gnode-kind">{nodeKind(box.node!)}</span>
                <span className="gnode-title" title={hoverLabel(box.node!)}>
                  {nodeLabel(box.node!)}
                </span>
              </button>
            ) : (
              <button
                key={box.key}
                type="button"
                className={`gnode gnode--${boxTone(box)}${selected?.entry.threadId === box.entry.threadId && !selected?.node ? " is-selected" : ""}`}
                style={boxStyle(box)}
                onClick={() => setSelected({ entry: box.entry, node: null })}
              >
                <span className="gnode-kind">{box.kind === "agent" ? (box.entry.agentType ?? "subagent") : "session"}</span>
                <span className="gnode-title" title={entryLabel(box.entry)}>
                  {entryLabel(box.entry)}
                </span>
                <span className="gnode-sub mono">
                  {box.entry.threadId.slice(0, 8)} · {box.entry.model ?? "—"}
                </span>
                <span className="gnode-chips">
                  <span>{fmtInt(box.entry.nodes.length)} steps</span>
                  {box.entry.errors > 0 ? <span className="gchip-error">{fmtInt(box.entry.errors)} err</span> : null}
                  {isInFlight(box.entry) ? <span className="gchip-flight">in flight</span> : null}
                </span>
              </button>
            ),
          )}
        </div>

        <SessionNav
          railRef={navRef}
          roots={roots}
          index={childIndex}
          selectedId={selectedId}
          focusId={focusId}
          collapsed={navCollapsed}
          onSelect={selectSession}
          onToggle={() => setNavCollapsed((c) => !c)}
        />

        <div className="graph-toolbar">
          <span className="graph-status">
            <span className={`glive${query.isFetching ? " is-live" : ""}`} aria-hidden />
            {fmtInt(roots.length)} sessions
            {entry ? <span className="muted"> · {fmtInt(entry.nodes.length)} steps</span> : null}
            {bands.length > 0 ? (
              <span className="muted">
                {" "}
                · {fmtInt(bands.length)} subagents
                {flying > 0 ? <span className="graph-status-flight"> ({fmtInt(flying)} in flight)</span> : null}
              </span>
            ) : null}
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
              <span key={l.tone} className="glegend-item">
                <span className="glegend-dot" style={{ background: color(l.tone) }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>

        {query.error ? <div className="graph-note error">Failed to load: {(query.error as Error).message}</div> : null}
        {!query.isLoading && all.length === 0 ? <div className="graph-note muted">No session transcripts yet.</div> : null}

        <Inspector
          panelRef={inspectorRef}
          selection={selected}
          byId={byId}
          sources={sources}
          wide={inspectorWide}
          onToggleWide={() => setInspectorWide((w) => !w)}
          onClose={() => setSelected(null)}
          onFocusAgent={setFocusId}
        />
      </div>
    </section>
  );
}

/** One rail row: a session, or one of its subagents indented beneath it. */
interface NavRow {
  entry: SessionGraphEntry;
  depth: number;
  childCount: number;
  expanded: boolean;
}

/** Flatten the agent tree into rail rows, skipping the subtrees the user folded away. */
function navRows(roots: SessionGraphEntry[], index: ChildIndex, folded: Set<string>): NavRow[] {
  const rows: NavRow[] = [];
  const walk = (entry: SessionGraphEntry, depth: number) => {
    const kids = childrenOf(index, entry.threadId);
    const expanded = !folded.has(entry.threadId);
    rows.push({ entry, depth, childCount: kids.length, expanded });
    if (!expanded) return;
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

/**
 * Left rail listing every session with its subagents nested beneath. Fixed over the
 * canvas; collapses to a narrow strip with an explicit re-open button. `railRef` exposes
 * its live width to the canvas.
 */
function SessionNav({
  railRef,
  roots,
  index,
  selectedId,
  focusId,
  collapsed,
  onSelect,
  onToggle,
}: {
  railRef: Ref<HTMLElement>;
  roots: SessionGraphEntry[];
  index: ChildIndex;
  selectedId: string | null;
  focusId: string | null;
  collapsed: boolean;
  onSelect: (entry: SessionGraphEntry) => void;
  onToggle: () => void;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const rows = useMemo(() => navRows(roots, index, folded), [roots, index, folded]);

  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <aside ref={railRef} className={`graph-sessions${collapsed ? " is-collapsed" : ""}`} aria-label="Sessions">
      <div className="gs-head">
        {collapsed ? null : <span className="gs-title">Sessions</span>}
        <button
          type="button"
          className="gs-collapse"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? "Show sessions" : "Hide sessions"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      {collapsed ? (
        <span className="gs-rail-label">{fmtInt(roots.length)} sessions</span>
      ) : (
        <div className="gs-list">
          {rows.map(({ entry, depth, childCount, expanded }) => {
            const isAgent = entry.parentThreadId !== null;
            const active = entry.threadId === (isAgent ? focusId : selectedId);
            return (
              <div key={entry.threadId} className="gs-row" style={{ paddingLeft: depth * 14 }}>
                {childCount > 0 ? (
                  <button
                    type="button"
                    className="gs-fold"
                    onClick={() => toggleFold(entry.threadId)}
                    aria-expanded={expanded}
                    aria-label={expanded ? "Hide subagents" : "Show subagents"}
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="gs-fold is-empty" aria-hidden>
                    {isAgent ? "↳" : ""}
                  </span>
                )}
                <button
                  type="button"
                  className={`gs-item${active ? " is-active" : ""}${isAgent ? " is-agent" : ""}`}
                  onClick={() => onSelect(entry)}
                >
                  <span className="gs-item-title">
                    {isAgent ? <span className="gs-item-type">{entry.agentType ?? "subagent"}</span> : null}
                    {entryLabel(entry)}
                  </span>
                  <span className="gs-item-meta mono">
                    {fmtLocalTsShort(entry.modified)} · {fmtInt(entry.nodes.length)} steps
                    {childCount > 0 ? <span className="gs-item-kids"> · {fmtInt(childCount)} agents</span> : null}
                    {entry.errors > 0 ? <span className="gs-item-err"> · {fmtInt(entry.errors)} err</span> : null}
                    {isInFlight(entry) ? <span className="gs-item-flight"> · in flight</span> : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function Inspector({
  panelRef,
  selection,
  byId,
  sources,
  wide,
  onToggleWide,
  onClose,
  onFocusAgent,
}: {
  panelRef: Ref<HTMLElement>;
  selection: Selection | null;
  byId: Map<string, SessionGraphEntry>;
  sources: Map<string, string>;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  onFocusAgent: (id: string) => void;
}) {
  if (!selection) return null;
  const { entry, node } = selection;
  const source = sources.get(entry.threadId);
  const agentType = node ? spawnAgentType(node) : null;
  const isAgent = !node && entry.parentThreadId !== null;
  const kind = node ? (agentType === null ? node.type : "spawn") : isAgent ? "subagent" : "session";
  const kindColor = color(node ? (agentType === null ? node.type : "agent") : isAgent ? "agent" : "root");
  const parent = entry.parentThreadId ? byId.get(entry.parentThreadId) : undefined;
  /** For a spawn step, the subagent it started. */
  const spawned = node
    ? [...byId.values()].find((s) => s.parentThreadId === entry.threadId && s.spawnIndex === node.index)
    : undefined;

  return (
    <aside ref={panelRef} className={`graph-inspector${wide ? " is-wide" : ""}`} aria-label="Node details">
      <div className="gi-head">
        <span className="gi-kind" style={{ "--gc": kindColor } as CSSProperties}>
          {kind}
        </span>
        <div className="gi-actions">
          <button
            type="button"
            className="gi-wide"
            onClick={onToggleWide}
            aria-expanded={wide}
            title={wide ? "Narrow the drawer" : "Widen the drawer"}
          >
            {wide ? "⇥" : "⇤"}
          </button>
          <button type="button" className="gi-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>

      <div className="gi-body">
        {node ? (
          <>
            {node.task ? (
              <Field label="Task">
                <LongText key={`t:${entry.threadId}:${node.index}`} text={node.task} />
              </Field>
            ) : null}
            {node.tool ? (
              <Field label="Tool">
                <LongText key={`c:${entry.threadId}:${node.index}`} text={node.tool} mono />
              </Field>
            ) : null}
            <Field label="Detail">
              {node.text ? <LongText key={`d:${entry.threadId}:${node.index}`} text={node.text} /> : <p className="gi-text">—</p>}
            </Field>
            <Field label="Step">#{node.index}</Field>
            {agentType === null ? null : spawned ? (
              <>
                <Field label="Subagent">{entryLabel(spawned)}</Field>
                <Field label="Status">{agentStatus(spawned)}</Field>
                <button type="button" className="link gi-open" onClick={() => onFocusAgent(spawned.threadId)}>
                  Show its branch →
                </button>
              </>
            ) : (
              <Field label="Subagent">
                <span className="muted">no transcript captured</span>
              </Field>
            )}
          </>
        ) : (
          <>
            {isAgent ? (
              <>
                <Field label="Agent type">{entry.agentType ?? "—"}</Field>
                <Field label="Status">{agentStatus(entry)}</Field>
                <Field label="Spawned by">{parent ? `${entryLabel(parent)} · step #${entry.spawnIndex}` : "—"}</Field>
              </>
            ) : null}
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
        {source ? (
          <Link to="/context/$file" params={{ file: source }} className="link gi-open">
            Open request breakdown →
          </Link>
        ) : (
          <span className="gi-note muted">Text from the transcript — no captured request matched.</span>
        )}
      </div>
    </aside>
  );
}

/** Whether a subagent is still running, or which parent step its result flowed into. */
function agentStatus(agent: SessionGraphEntry): ReactNode {
  return agent.returnIndex === null ? (
    <span className="gi-flight">in flight — the parent hasn't stepped past the spawn</span>
  ) : (
    <>returned into parent step #{agent.returnIndex}</>
  );
}

/** Past this much text a value is folded away until asked for. */
const LONG_TEXT_CHARS = 280;

/**
 * A value that may run long — request-derived steps carry whole prompts and command
 * lines. Short ones render plainly; long ones clamp to a few lines behind a toggle that
 * opens them in full. Give it a key tied to the step so opening one doesn't open the next.
 */
function LongText({ text, mono }: { text: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT_CHARS;
  const cls = `gi-text${mono ? " mono-break" : ""}${long && !open ? " is-clamped" : ""}`;

  return (
    <>
      <p className={cls}>{text}</p>
      {long ? (
        <button type="button" className="link gi-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Show less" : `Show all ${fmtInt(text.length)} characters`}
        </button>
      ) : null}
    </>
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
