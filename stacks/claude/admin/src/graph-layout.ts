import type { InterruptionKind, SessionNode } from '@claude-proxy/core';
import { spawnAgentType } from '@claude-proxy/core';
import type { SessionGraphEntry } from './api';
import type { BuiltGrain } from './graph-grains';

/**
 * The live graph's layout engine — one pass that takes a **grain** and the node set that
 * grain projects, and answers placed boxes, edges, branch bands and interruption trails.
 * It holds no React and nothing the page renders: the route asks for a layout and draws it,
 * and a coarser view calls the same entry point with a different projection.
 *
 * Steps snake in rows so a long run folds onto the screen. A subagent draws as its own
 * (recursive) layout framed in a band, and **branches are packed into columns beside the
 * run**: two live at the same moment stand side by side, two that never overlapped share a
 * column and cost no width.
 */

/** Box geometry, in canvas px (pre-transform). The gaps and insets below don't vary with it. */
export interface Sizes {
  rootW: number;
  rootH: number;
  nodeW: number;
  nodeH: number;
  /** Uniform grid cell; boxes are centered within it. */
  cellW: number;
  cellH: number;
}

const sizes = (rootW: number, rootH: number, nodeW: number, nodeH: number): Sizes => ({
  rootW,
  rootH,
  nodeW,
  nodeH,
  cellW: rootW,
  cellH: rootH,
});

/** The default: as many steps on screen as the fold allows, each a two-line gist. */
export const COMPACT = sizes(224, 96, 168, 64);
/**
 * The "larger nodes" toggle: boxes roomy enough for a step's whole label. Toggling re-lays
 * out at the same zoom — a refit would scale the bigger boxes straight back down.
 */
export const ROOMY = sizes(360, 232, 320, 216);

export const GAP_X = 44;
export const GAP_Y = 58;
export const PAD = 64;
/** A branch band's inner padding and its label strip. */
const BAND_PAD = 18;
const BAND_HEAD = 34;
/** Clearance between a band and whatever it sits beside or beneath. */
const BAND_GAP = 26;
/** Gap between two branch columns. */
const BAND_COL_GAP = 30;
/** A side trail's indent from its session's left edge, and the air above it. */
const TRAIL_INSET = 72;
const TRAIL_GAP = 52;

/** What a box or edge is about — drives its glow color. */
export type Tone = SessionNode['type'] | 'root' | 'agent' | 'cut';

/** Tone → CSS color token. */
const NODE_COLOR = {
  task: 'var(--signal)',
  decision: 'var(--muted)',
  tool: 'var(--amber)',
  error: 'var(--coral)',
  done: 'var(--good)',
  root: 'var(--signal-dim)',
  agent: 'var(--violet)',
  cut: 'var(--coral)',
} satisfies Record<Tone, string>;

/** Total color lookup (indexing is `string | undefined` under noUncheckedIndexedAccess). */
export const color = (tone: Tone): string => NODE_COLOR[tone] ?? 'var(--signal)';

/** Rows-per-fold from the viewport width: 1 = vertical (mobile), more = longer rows. */
export function colsForWidth(w: number): number {
  if (w < 700) return 1;
  if (w < 1024) return 3;
  if (w < 1440) return 5;
  return 7;
}

/**
 * A subagent's parent hasn't taken a step past the spawn, so nothing has come back yet.
 * This is the parent's record, so it pairs with `entry.liveness` rather than duplicating
 * it: a dispatch whose result the harness ate reads as in flight *and* `running`.
 */
export const isInFlight = (entry: SessionGraphEntry): boolean =>
  entry.parentThreadId !== null && entry.returnIndex === null;

/** A placed box on the canvas plus the data behind it (node is null for a session root). */
export interface Box {
  key: string;
  /** `root` = the canvased session, `agent` = a subagent's own root, `node` = one step. */
  kind: 'root' | 'agent' | 'node';
  x: number;
  y: number;
  w: number;
  h: number;
  entry: SessionGraphEntry;
  node: SessionNode | null;
}

/**
 * An edge as its two endpoints rather than a path string, so a whole sub-layout can be
 * translated into the column it was packed into without re-deriving its curves.
 * {@link edgePath} turns one into the `d` the SVG wants.
 */
export interface Edge {
  key: string;
  /**
   * `step` follows one session's chain; `spawn`/`return` cross into and out of a branch;
   * `sever` leaves an interrupted step for the side trail the run resumed on.
   */
  kind: 'step' | 'spawn' | 'return' | 'sever';
  color: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** `h` bends through a shared mid-x (within a snake row), `v` through a shared mid-y. */
  curve: 'h' | 'v';
}

/** The S-curve between an edge's endpoints. */
export function edgePath(e: Edge): string {
  if (e.curve === 'h') {
    const mx = (e.x1 + e.x2) / 2;
    return `M ${e.x1} ${e.y1} C ${mx} ${e.y1} ${mx} ${e.y2} ${e.x2} ${e.y2}`;
  }
  const my = (e.y1 + e.y2) / 2;
  return `M ${e.x1} ${e.y1} C ${e.x1} ${my} ${e.x2} ${my} ${e.x2} ${e.y2}`;
}

/** The nested frame drawn around one subagent's branch. */
export interface Band {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  entry: SessionGraphEntry;
  inFlight: boolean;
}

/** The frame drawn around the run of steps that followed one interruption. */
export interface Trail {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  entry: SessionGraphEntry;
  kind: InterruptionKind;
  /** What the run was redirected to — the resuming step's own text. */
  label: string;
}

/** Subagents indexed by the step that spawned them: parent thread id → spawn index → child. */
export type ChildIndex = Map<string, Map<number, SessionGraphEntry>>;

export function indexChildren(entries: SessionGraphEntry[]): ChildIndex {
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
export function childrenOf(index: ChildIndex, threadId: string): SessionGraphEntry[] {
  return [...(index.get(threadId)?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([, child]) => child);
}

/** A spawn step is labelled by the kind of agent it started, not its raw signature. */
export function nodeLabel(node: SessionNode): string {
  const agent = spawnAgentType(node);
  if (agent !== null) return agent || 'subagent';
  if (node.type === 'tool' && node.tool) return node.tool;
  return node.text || node.type;
}

/** What a box is about: a session root, a subagent (its root or the step spawning it), or a step. */
export function boxTone(box: Box): Tone {
  if (box.kind === 'root') return 'root';
  if (box.kind === 'agent') return 'agent';
  return spawnAgentType(box.node!) === null ? box.node!.type : 'agent';
}

interface Placed {
  boxes: Box[];
  edges: Edge[];
  bands: Band[];
  trails: Trail[];
  /** Rightmost / lowest canvas coordinate reached, so a caller can frame around it. */
  right: number;
  bottom: number;
}

/** One box to place: a session/subagent root, or one step. */
interface Item {
  kind: Box['kind'];
  node: SessionNode | null;
}

/**
 * Move a finished sub-layout bodily. Every coordinate the engine produces is an offset from
 * the origin it was laid out at, so a branch can be measured at (0, 0) and only then placed
 * in whichever column it fits — which is what lets siblings share a row.
 */
function shift(placed: Placed, dx: number, dy: number): Placed {
  if (dx === 0 && dy === 0) return placed;
  return {
    boxes: placed.boxes.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
    edges: placed.edges.map((e) => ({ ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy })),
    bands: placed.bands.map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
    trails: placed.trails.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy })),
    right: placed.right + dx,
    bottom: placed.bottom + dy,
  };
}

/** Grid cell (row + left-to-right column) for the i-th item in a boustrophedon snake. */
function cell(i: number, cols: number) {
  const row = Math.floor(i / cols);
  const posInRow = i % cols;
  const leftToRight = row % 2 === 0;
  const col = leftToRight ? posInRow : cols - 1 - posInRow;
  return { row, col };
}

/** Endpoints of a vertical edge between two boxes, leaving whichever face is nearer. */
function boxEdge(from: Box, to: Box): Pick<Edge, 'x1' | 'y1' | 'x2' | 'y2' | 'curve'> {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  // Leave by whichever face actually points at the target: a branch packed into a column
  // beside its parent is reached sideways, one below it is still reached from underneath.
  if (Math.abs(dx) > Math.abs(dy)) {
    const y1 = from.y + from.h / 2;
    const y2 = to.y + to.h / 2;
    return dx > 0
      ? { x1: from.x + from.w, y1, x2: to.x, y2, curve: 'h' }
      : { x1: from.x, y1, x2: to.x + to.w, y2, curve: 'h' };
  }
  const above = dy < 0;
  return {
    x1: from.x + from.w / 2,
    y1: above ? from.y : from.y + from.h,
    x2: to.x + to.w / 2,
    y2: above ? to.y + to.h : to.y,
    curve: 'v',
  };
}

/**
 * Split a session's steps at every interruption. The first run continues the snake the
 * root opens; each later one is what the run picked up as after being cut off.
 */
function runsOf(nodes: SessionNode[]): SessionNode[][] {
  const runs: SessionNode[][] = [[]];
  for (const node of nodes) {
    const current = runs[runs.length - 1]!;
    // A leading interruption has nothing behind it to depart from — it opens the snake.
    if (node.interruption && current.length > 0) runs.push([node]);
    else current.push(node);
  }
  return runs;
}

/**
 * Snake one run of boxes from (`x0`, `y0`), folding every `cols` boxes. The fold's own rows
 * are laid first and reserve no room for branches; every subagent this run spawned is then
 * measured at the origin and moved into the leftmost column to the right of the fold that is
 * already clear at the height its spawning row sits at. Branches alive together therefore
 * take neighbouring columns, and ones that finished before the next began reuse one.
 */
function layoutRun(
  entry: SessionGraphEntry,
  items: Item[],
  cols: number,
  x0: number,
  y0: number,
  index: ChildIndex,
  depth: number,
  runKey: string,
  size: Sizes,
  grain: BuiltGrain,
): Placed {
  const spawned = index.get(entry.threadId);

  const boxes: Box[] = [];
  const edges: Edge[] = [];
  const bands: Band[] = [];
  const trails: Trail[] = [];
  /** Every subagent this run spawned, with the top of the row it was spawned from. */
  const branches: { child: SessionGraphEntry; top: number }[] = [];
  let right = x0;
  let y = y0;

  const rows = Math.ceil(items.length / cols);
  for (let row = 0; row < rows; row++) {
    const rowTop = y;
    const from = row * cols;
    const to = Math.min(items.length, from + cols);

    for (let i = from; i < to; i++) {
      const it = items[i]!;
      const cellX = x0 + cell(i, cols).col * (size.cellW + GAP_X);
      const w = it.kind === 'node' ? size.nodeW : size.rootW;
      const h = it.kind === 'node' ? size.nodeH : size.rootH;
      boxes.push({
        key: it.node ? `${entry.threadId}:${it.node.index}` : `r:${entry.threadId}`,
        kind: it.kind,
        x: cellX + (size.cellW - w) / 2,
        y: rowTop + (size.cellH - h) / 2,
        w,
        h,
        entry,
        node: it.node,
      });
      right = Math.max(right, cellX + size.cellW);
    }

    // The subagents this row spawned, each remembered against the row it left from.
    for (let i = from; i < to; i++) {
      const node = items[i]!.node;
      const child = node ? spawned?.get(node.index) : undefined;
      if (child) branches.push({ child, top: rowTop });
    }

    y = rowTop + size.cellH + GAP_Y;
  }
  const foldBottom = Math.max(y0, y - GAP_Y);
  let bottom = foldBottom;

  // Chain this session's own boxes — nested ones were chained by the recursive call.
  const own = boxes.filter((b) => b.entry.threadId === entry.threadId);
  for (let i = 0; i < own.length - 1; i++) {
    const a = own[i]!;
    const b = own[i + 1]!;
    let ends: Pick<Edge, 'x1' | 'y1' | 'x2' | 'y2' | 'curve'>;
    if (cell(i, cols).row === cell(i + 1, cols).row) {
      // Within a row — connect the facing horizontal edges, whichever way the row runs.
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      ends =
        a.x < b.x
          ? { x1: a.x + a.w, y1: ay, x2: b.x, y2: by, curve: 'h' }
          : { x1: a.x, y1: ay, x2: b.x + b.w, y2: by, curve: 'h' };
    } else {
      // Turning onto the next row — drop from one box's bottom to the next's top.
      ends = { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y, curve: 'v' };
    }
    edges.push({ key: `e:${runKey}:${i}`, kind: 'step', color: color(boxTone(b)), ...ends });
  }

  // Pack the branches into columns beside the fold: each band is measured at the origin, then
  // moved into the leftmost column already clear at the height it wants.
  if (branches.length > 0) {
    const childCols = Math.max(1, cols - 1);
    const columns: {
      bottom: number;
      w: number;
      put: { placed: Placed; child: SessionGraphEntry; top: number; w: number; h: number }[];
    }[] = [];

    for (const { child, top } of branches) {
      const placed = layoutTree(child, childCols, 0, 0, index, depth + 1, size, grain);
      const w = placed.right + BAND_PAD * 2;
      const h = placed.bottom + BAND_HEAD + BAND_PAD;
      let column = columns.find((c) => c.bottom + BAND_GAP <= top);
      if (!column) {
        column = { bottom: Number.NEGATIVE_INFINITY, w: 0, put: [] };
        columns.push(column);
      }
      column.put.push({ placed, child, top, w, h });
      column.bottom = top + h;
      column.w = Math.max(column.w, w);
    }

    let colX = right + BAND_GAP;
    for (const column of columns) {
      for (const { placed, child, top, w, h } of column.put) {
        const inner = shift(placed, colX + BAND_PAD, top + BAND_HEAD);
        bands.push({
          key: `b:${child.threadId}`,
          x: colX,
          y: top,
          w,
          h,
          entry: child,
          inFlight: isInFlight(child),
        });
        bands.push(...inner.bands);
        boxes.push(...inner.boxes);
        edges.push(...inner.edges);
        trails.push(...inner.trails);
        bottom = Math.max(bottom, top + h);
      }
      colX += column.w + BAND_COL_GAP;
    }
    right = Math.max(right, colX - BAND_COL_GAP);
  }

  return { boxes, edges, bands, trails, right, bottom };
}

/**
 * Lay out one session at the given grain: its root and steps as a snake, and everything
 * after an interruption as its own trail — inset, framed, and reached by a severed edge off
 * the step that was cut short. Trails stack at one indent however many there are: they are
 * the same run resumed, not parallel work, so they read down the page rather than across.
 */
function layoutTree(
  entry: SessionGraphEntry,
  cols: number,
  x0: number,
  y0: number,
  index: ChildIndex,
  depth: number,
  size: Sizes,
  grain: BuiltGrain,
): Placed {
  const runs = runsOf(grain.project(entry));
  const head: Item[] = [
    { kind: depth === 0 ? 'root' : 'agent', node: null },
    ...runs[0]!.map((node) => ({ kind: 'node' as const, node })),
  ];

  const placed = layoutRun(entry, head, cols, x0, y0, index, depth, `${entry.threadId}:0`, size, grain);
  const boxes = [...placed.boxes];
  const edges = [...placed.edges];
  const bands = [...placed.bands];
  const trails = [...placed.trails];
  let right = placed.right;
  let bottom = placed.bottom;

  for (let r = 1; r < runs.length; r++) {
    const steps = runs[r]!;
    const opener = steps[0]!;
    const trailTop = bottom + TRAIL_GAP;
    const trailX = x0 + TRAIL_INSET;
    const inner = layoutRun(
      entry,
      steps.map((node) => ({ kind: 'node' as const, node })),
      Math.max(1, cols - 1),
      trailX + BAND_PAD,
      trailTop + BAND_HEAD,
      index,
      depth,
      `${entry.threadId}:${r}`,
      size,
      grain,
    );
    const trailRight = inner.right + BAND_PAD;
    trails.push({
      key: `t:${entry.threadId}:${opener.index}`,
      x: trailX,
      y: trailTop,
      w: trailRight - trailX,
      h: inner.bottom + BAND_PAD - trailTop,
      entry,
      kind: opener.interruption ?? 'user',
      label: nodeLabel(opener),
    });
    trails.push(...inner.trails);
    bands.push(...inner.bands);
    boxes.push(...inner.boxes);
    edges.push(...inner.edges);

    // The cut itself: off the step the interruption landed on, into the trail's first step.
    const severed = boxes.find((b) => b.node?.index === opener.index - 1 && b.entry.threadId === entry.threadId);
    const resumed = inner.boxes.find((b) => b.node?.index === opener.index);
    if (severed && resumed) {
      edges.push({
        key: `sv:${entry.threadId}:${opener.index}`,
        kind: 'sever',
        color: color('cut'),
        ...boxEdge(severed, resumed),
      });
    }

    right = Math.max(right, trailRight);
    bottom = inner.bottom + BAND_PAD;
  }

  return { boxes, edges, bands, trails, right, bottom };
}

export interface GraphLayout {
  boxes: Box[];
  edges: Edge[];
  bands: Band[];
  trails: Trail[];
  contentW: number;
  contentH: number;
}

/**
 * The engine's entry point: lay the selected session out at one grain, with every subagent
 * branch packed into a column beside it, then wire the cross-session edges — spawn (parent step →
 * subagent root) and return (the subagent's last step → the parent step its result flows
 * into). Those wait until every box is placed, since a return can land on a row below the
 * branch, and a grain that folds the spawning step away simply has no edge to draw.
 */
export function layoutGraph({
  entry,
  cols,
  index,
  size,
  grain,
}: {
  entry: SessionGraphEntry | null;
  cols: number;
  index: ChildIndex;
  size: Sizes;
  grain: BuiltGrain;
}): GraphLayout {
  if (!entry) return { boxes: [], edges: [], bands: [], trails: [], contentW: 0, contentH: 0 };

  const placed = layoutTree(entry, cols, PAD, PAD, index, 0, size, grain);
  const boxAt = new Map(placed.boxes.map((b) => [b.key, b]));
  const edges = [...placed.edges];

  for (const { entry: child } of placed.bands) {
    const spawn = boxAt.get(`${child.parentThreadId}:${child.spawnIndex}`);
    const root = boxAt.get(`r:${child.threadId}`);
    if (spawn && root) {
      edges.push({ key: `sp:${child.threadId}`, kind: 'spawn', color: color('agent'), ...boxEdge(spawn, root) });
    }

    // The branch's last step back into the parent step it rejoins — absent while in flight.
    const lastNode = child.nodes[child.nodes.length - 1];
    const last = lastNode ? boxAt.get(`${child.threadId}:${lastNode.index}`) : root;
    const rejoin = child.returnIndex === null ? undefined : boxAt.get(`${child.parentThreadId}:${child.returnIndex}`);
    if (last && rejoin) {
      edges.push({ key: `rt:${child.threadId}`, kind: 'return', color: color('agent'), ...boxEdge(last, rejoin) });
    }
  }

  return { ...placed, edges, contentW: placed.right + PAD, contentH: placed.bottom + PAD };
}
