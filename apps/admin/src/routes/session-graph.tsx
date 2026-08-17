import type { InterruptionKind, SessionNode } from '@claude-proxy/core';
import { mergeSessionNodes, sessionName, spawnAgentType, stripCommandEnvelope } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Expand, Maximize2, Minimize2, Network, Shrink } from 'lucide-react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionGraphEntry } from '../api';
import { getCommands, getContextMessage, getSessionGraphNodes, getSessionNodeTexts, getSessionsGraph } from '../api';
import { livenessTitle } from '../components/LivenessBadge';
import { Skeleton, SkeletonStatus } from '../components/Skeleton';
import { fmtInt, fmtLocalTsShort } from '../format';
import type { AgentFacts } from '../graph-agents';
import { agentLabel, indexAgents } from '../graph-agents';
import type { CommandFamily, CommandRunSpan } from '../graph-commands';
import { FAMILY_LABEL, FAMILY_TOKEN, indexCommandRuns, runLabel } from '../graph-commands';
import type { GrainId } from '../graph-grains';
import { commandGrain, GRAINS, grainById, isBuilt, TURN_GRAIN } from '../graph-grains';
import type { Box, ChildIndex, Tone } from '../graph-layout';
import {
  boxTone,
  COMPACT,
  childrenOf,
  color,
  colsForWidth,
  edgePath,
  GAP_X,
  GAP_Y,
  indexChildren,
  isInFlight,
  layoutGraph,
  nodeLabel,
  PAD,
  ROOMY,
} from '../graph-layout';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * Live session graph — one session at a time, its appended steps (task / decision /
 * tool / error / done) chained into a snake so a long run folds onto the screen
 * instead of running off the right. Rows-per-fold adapt to the viewport (mobile
 * flows top-to-bottom, desktop uses long rows). A collapsible left rail switches
 * sessions; the toolbar floats above the canvas. Polls so new steps stream in.
 *
 * `?session=<threadId>` opens the graph on one session rather than the newest; picking in
 * the rail writes it back.
 *
 * A subagent keeps its own transcript, so it draws as a branch: the parent's `Agent(…)`
 * step opens an indented band around the subagent's own snake, and a return edge carries
 * it back into the parent step its result flows into. The rail nests the same tree.
 *
 * The transcript only fixes *which* steps exist — it gists every line to 160 chars, so the
 * text comes from the canvased family's Request breakdown, where the same steps are whole.
 */

/** Overlay panels with their own scrollbar; a collapsed rail has nothing to scroll. */
const SCROLLS_ITSELF = '.graph-sessions:not(.is-collapsed), .graph-inspector';

const ZOOM_HINT = 'Scroll to pan · ⌘-scroll or pinch to zoom';

/** Pointer travel, in px, past which a press on the canvas is a pan rather than a click. */
const PAN_SLOP = 4;

const LEGEND: { tone: Tone; label: string }[] = [
  { tone: 'task', label: 'task' },
  { tone: 'decision', label: 'decision' },
  { tone: 'tool', label: 'tool' },
  { tone: 'agent', label: 'subagent' },
  { tone: 'error', label: 'error' },
  { tone: 'done', label: 'done' },
  { tone: 'cut', label: 'interrupted' },
];

/** The command grain's own legend: one swatch per family, most-changing first. */
const COMMAND_LEGEND: CommandFamily[] = ['build', 'shape', 'review', 'read', 'other'];

/** The agent grain's legend: the only two kinds of box that projection leaves on the canvas. */
const AGENT_LEGEND: { tone: Tone; label: string }[] = [
  { tone: 'root', label: 'session' },
  { tone: 'agent', label: 'agent' },
];

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Harness-injected context, not the user's words — including a block cut off mid-way. */
const stripReminders = (s: string): string =>
  s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system-reminder>[\s\S]*$/i, '')
    .trim();

/**
 * The most human name a transcript offers. Transcripts written before the proxy recorded
 * a reminder-free subtitle open with an injected context blob, so fall back to the first
 * task that says something.
 */
function entryLabel(entry: SessionGraphEntry): string {
  const name = sessionName(entry);
  if (name) return name;
  for (const node of entry.nodes) {
    if (node.type !== 'task') continue;
    const text = stripReminders(node.text);
    if (text) return text;
  }
  return entry.threadId;
}

/** How each interruption reads on a trail's head strip. */
const INTERRUPTION_LABEL: Record<InterruptionKind, string> = {
  user: 'interrupted by user',
  'tool-use': 'interrupted mid-tool',
  stopped: 'stopped from the dashboard',
  timeout: 'timed out',
  limit: 'hit its ceiling',
};

const interruptionLabel = (kind: InterruptionKind): string => INTERRUPTION_LABEL[kind] ?? 'interrupted';

interface Selection {
  entry: SessionGraphEntry;
  node: SessionNode | null;
}

interface View {
  x: number;
  y: number;
  k: number;
}

/**
 * Node style carries its glow color via the `--gc` custom property, plus the cut's for a severed
 * step. A command run overrides both that and its fill with its family's pair, so the box is
 * coloured by what the command does rather than by the step type the projection folded away.
 */
function boxStyle(box: Box, run?: CommandRunSpan): CSSProperties {
  const family = run ? FAMILY_TOKEN[run.family] : null;
  return {
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    '--gc': family ? family.edge : color(boxTone(box)),
    '--cut': color('cut'),
    ...(family ? { '--cf': family.fill } : {}),
  } as CSSProperties;
}

/**
 * Ghost boxes on the canvas while the first poll is in flight — a session box with its
 * steps trailing to the right, laid out from the same `COMPACT` geometry and gaps the
 * real snake uses, so the real boxes replace these at the same size and place.
 */
function GraphSkeleton({ rows = 2, steps = 4 }: { rows?: number; steps?: number }) {
  const s = COMPACT;
  const ghost = (x: number, y: number, w: number, h: number, key: string): ReactNode => (
    <div
      key={key}
      className='gnode'
      style={{ left: x, top: y, width: w, height: h, '--gc': color('decision') } as CSSProperties}
      aria-hidden>
      <span className='gnode-kind'>
        <Skeleton w='3.5rem' />
      </span>
      <span className='gnode-title'>
        <Skeleton w='82%' />
      </span>
    </div>
  );

  return (
    <>
      {Array.from({ length: rows }, (_, r) => {
        const y = PAD + r * (s.rootH + GAP_Y);
        const stepY = y + (s.rootH - s.nodeH) / 2;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
          <Fragment key={r}>
            {ghost(PAD, y, s.rootW, s.rootH, `root-${r}`)}
            {Array.from({ length: steps }, (_, i) =>
              ghost(PAD + s.rootW + GAP_X + i * (s.nodeW + GAP_X), stepY, s.nodeW, s.nodeH, `step-${r}-${i}`),
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** The extra layer a step wears when the run was cut off on it, or resumed on it. */
function cutClass(node: SessionNode): string {
  return `${node.interrupted ? ' is-cut' : ''}${node.interruption ? ' is-resumed' : ''}`;
}

const nodeKind = (node: SessionNode): string => (spawnAgentType(node) === null ? node.type : 'spawn');

/** A peek at the step text for the hover tooltip — untruncated, it runs to thousands of chars. */
function hoverLabel(node: SessionNode): string {
  const label = nodeLabel(node);
  return label.length > 300 ? `${label.slice(0, 299)}…` : label;
}

/** How often to re-read the family's captured requests — far heavier than the transcript poll. */
const NODES_REFETCH_MS = 20_000;

export function SessionGraphPage() {
  const { session: requested } = useSearch({ from: '/sessions/graph' });
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['sessions-graph'], queryFn: getSessionsGraph, refetchInterval: 4000 });
  const transcripts = useMemo(() => query.data?.sessions ?? [], [query.data]);

  // Selection resolves off the transcripts — the breakdown's text changes no thread id
  // and no parent link.
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
  /** The branch to highlight and center, set by picking a subagent in the rail. */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** The `?session=` already honoured, so the rail stays in charge once it has been. */
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (transcripts.length === 0) return;
    // `?session=`: canvas that session's family, centering the branch when it names a
    // subagent. Waits out an id the poll hasn't seen yet.
    if (requested !== undefined && byThread.has(requested) && opened.current !== requested) {
      opened.current = requested;
      setSelectedId(rootOf(requested));
      setFocusId(byThread.get(requested)!.parentThreadId === null ? null : requested);
      return;
    }
    setSelectedId((prev) => rootOf(prev && byThread.has(prev) ? prev : transcripts[0]!.threadId));
  }, [transcripts, byThread, rootOf, requested]);

  // The canvased family's steps, re-read from its captured requests so nothing is gisted.
  // Failure is silent: the transcript still draws the graph, just abbreviated.
  const nodesQuery = useQuery({
    queryKey: ['session-graph-nodes', selectedId],
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
  const [roomy, setRoomy] = useState(false);
  /** The grain the engine draws at. Only built grains are selectable, so this always resolves. */
  const [grainId, setGrainId] = useState<GrainId>(TURN_GRAIN.id);

  // Which `Skill(…)` names open a command run is a fact about what is installed, so the command
  // grain is bound to the catalogue rather than guessing from the transcript. Fetched only for
  // that grain; until it lands, every skill call counts, which over-draws rather than emptying.
  // The agent grain wants it too — an agent box's drawer lists the commands that agent ran.
  const commandsQuery = useQuery({
    queryKey: ['commands'],
    queryFn: getCommands,
    enabled: grainId === 'command' || grainId === 'agent',
    staleTime: 5 * 60_000,
  });
  const installed = useMemo(
    () => new Set((commandsQuery.data?.commands ?? []).map((c) => c.command.toLowerCase())),
    [commandsQuery.data],
  );
  const isCommand = useCallback((name: string) => installed.size === 0 || installed.has(name), [installed]);

  const grain = useMemo(() => {
    const picked = grainById(grainId);
    if (picked.id === 'command') return commandGrain(isCommand);
    return isBuilt(picked) ? picked : TURN_GRAIN;
  }, [grainId, isCommand]);
  const size = roomy ? ROOMY : COMPACT;
  const { boxes, edges, bands, trails, contentW, contentH } = useMemo(
    () => layoutGraph({ entry, cols, index: childIndex, size, grain }),
    [entry, cols, childIndex, size, grain],
  );

  // The runs behind the boxes the command grain placed — a projected node keeps the index of the
  // step that opened its run, so a box finds its span by thread and index.
  const runIndex = useMemo(
    () => (grainId === 'command' ? indexCommandRuns(all, isCommand) : null),
    [grainId, all, isCommand],
  );
  const runOf = useCallback(
    (box: Box): CommandRunSpan | undefined =>
      box.node ? runIndex?.get(box.entry.threadId)?.get(box.node.index) : undefined,
    [runIndex],
  );

  // The agents behind the boxes the agent grain placed, keyed by dispatching thread and step.
  const agentIndex = useMemo(
    () => (grainId === 'agent' ? indexAgents(all, isCommand) : null),
    [grainId, all, isCommand],
  );
  const agentOf = useCallback(
    (box: Box): AgentFacts | undefined =>
      box.node ? agentIndex?.get(box.entry.threadId)?.get(box.node.index) : undefined,
    [agentIndex],
  );

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
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  /** Set once a pan travels far enough to count as a drag, so it doesn't read as a click. */
  const panMoved = useRef(false);

  /**
   * The slice of the viewport left free by the two overlays — the session rail on the left
   * and the details drawer on the right. Both sit *over* the canvas rather than shrinking it,
   * so their widths are measured live: each animates between states, the rail caps at a share
   * of narrow viewports, and the drawer is absent when nothing is selected. Floored, so a
   * widened drawer on a small viewport can't collapse the frame to nothing.
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

  // Refit only when the session, fold width or grain changes — not on every poll, or
  // streaming steps would keep yanking the view back. `fitRef` keeps the effect off `fit`'s deps.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refitting on these three and nothing else is the point — see the note above
  useEffect(() => {
    const id = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(id);
  }, [selectedId, cols, grainId]);

  // Center a focused branch. Boxes come through a ref so a poll's new steps can't
  // re-center; only a fresh pick (or a re-fold) moves the view.
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  // biome-ignore lint/correctness/useExhaustiveDependencies: boxes come through a ref so a poll cannot re-center; only these deps may move the view
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

  // A plain wheel pans; ⌘-wheel and trackpad pinch (reported as ctrl-wheel) zoom about
  // the cursor. Native listener so we can preventDefault.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The overlay panels sit inside the viewport, so their wheels bubble here.
      if ((e.target as HTMLElement).closest(SCROLLS_ITSELF)) return;
      e.preventDefault();

      if (!e.metaKey && !e.ctrlKey) {
        // Shift-wheel on a plain mouse still arrives as deltaY; read it as horizontal.
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
        return;
      }

      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // A pinch streams many small deltas, so scale it continuously; a wheel notch steps.
      const factor = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((v) => {
        const k = clamp(v.k * factor, 0.1, 3);
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Track fullscreen (Esc exits natively; sync our flag and refit to the new size).
  useEffect(() => {
    const onChange = () => {
      setIsFull(document.fullscreenElement === viewportRef.current);
      requestAnimationFrame(() => fitRef.current());
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Esc closes the inspector when we're not in fullscreen (there Esc exits fullscreen instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleFull = () => {
    const el = viewportRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  };

  /**
   * Picking a session canvases it; picking a subagent canvases its family and centers that
   * branch. The pick lands in `?session=`, replacing rather than pushing — the rail isn't history.
   */
  const selectSession = (picked: SessionGraphEntry) => {
    setSelectedId(rootOf(picked.threadId));
    setFocusId(picked.parentThreadId === null ? null : picked.threadId);
    setSelected(null);
    void navigate({ to: '/sessions/graph', search: { session: picked.threadId }, replace: true });
  };

  /**
   * The agent drawer's way down into the finer views: redraw at the grain that shows what was
   * clicked, center the agent it belongs to, and open the drawer on that box. The grain change
   * refits and the focus change recenters, so the box lands on screen rather than merely selected.
   */
  const openAt = useCallback((grain: GrainId, target: SessionGraphEntry, node: SessionNode | null) => {
    setGrainId(grain);
    setFocusId(target.parentThreadId === null ? null : target.threadId);
    setSelected({ entry: target, node });
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (
      t.closest('.gnode') ||
      t.closest('.gband-head') ||
      t.closest('.graph-toolbar') ||
      t.closest('.graph-inspector') ||
      t.closest('.graph-sessions')
    )
      return;
    pan.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    panMoved.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.sx) > PAN_SLOP || Math.abs(e.clientY - p.sy) > PAN_SLOP) panMoved.current = true;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  };
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    pan.current = null;
    setDragging(false);
    // A pan only starts on empty canvas, so a stationary one is a click off the nodes.
    if (!panMoved.current) setSelected(null);
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
    <section className='graph-page'>
      {query.isLoading ? <SkeletonStatus label='Loading the session graph' /> : null}
      <div
        ref={viewportRef}
        className={`graph-viewport${isFull ? ' is-full' : ''}${dragging ? ' is-dragging' : ''}`}
        style={viewportStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}>
        <div className={`graph-canvas${roomy ? ' is-roomy' : ''}`} style={canvasStyle}>
          {query.isLoading ? <GraphSkeleton /> : null}
          {/* Branch frames sit behind the edges and boxes they enclose. */}
          {bands.map((band) => (
            <div
              key={band.key}
              className={`gband${band.inFlight ? ' is-flight' : ''}${focusId === band.entry.threadId ? ' is-focus' : ''}`}
              style={{ left: band.x, top: band.y, width: band.w, height: band.h }}>
              <button
                type='button'
                className='gband-head'
                onClick={() => setSelected({ entry: band.entry, node: null })}>
                <span className='gband-kind'>subagent</span>
                <span className='gband-type'>{band.entry.agentType ?? 'agent'}</span>
                <span className='gband-title'>{entryLabel(band.entry)}</span>
                <span className={`gband-state${band.inFlight ? ' is-flight' : ''}`}>
                  {band.inFlight ? 'in flight' : 'returned'}
                </span>
              </button>
            </div>
          ))}

          {/* A trail frames what the run did after being cut off — same layer as a branch band. */}
          {trails.map((trail) => (
            <div
              key={trail.key}
              className='gtrail'
              style={{ left: trail.x, top: trail.y, width: trail.w, height: trail.h }}>
              <div className='gtrail-head'>
                <span className='gtrail-kind'>interrupted</span>
                <span className='gtrail-why'>{interruptionLabel(trail.kind)}</span>
                <span className='gtrail-title' title={trail.label}>
                  {trail.label}
                </span>
              </div>
            </div>
          ))}

          <svg className='graph-edges' width={contentW} height={contentH} aria-hidden='true'>
            <defs>
              {/* Points a return edge at the parent step it lands on. */}
              <marker
                id='graph-return-arrow'
                viewBox='0 0 8 8'
                refX='7'
                refY='4'
                markerWidth='5'
                markerHeight='5'
                orient='auto'>
                <path d='M 0 0 L 8 4 L 0 8 z' fill='var(--violet)' />
              </marker>
            </defs>
            {edges.map((e) => (
              <path
                key={e.key}
                className={`graph-edge graph-edge--${e.kind}`}
                d={edgePath(e)}
                style={{ stroke: e.color }}
                markerEnd={e.kind === 'return' ? 'url(#graph-return-arrow)' : undefined}
              />
            ))}
          </svg>

          {boxes.map((box) =>
            box.kind === 'node' ? (
              <CommandOrStepBox
                key={box.key}
                box={box}
                run={runOf(box)}
                agent={agentOf(box)}
                selected={
                  !!selected?.node &&
                  selected.entry.threadId === box.entry.threadId &&
                  selected.node.index === box.node!.index
                }
                onSelect={() => setSelected({ entry: box.entry, node: box.node })}
              />
            ) : (
              <button
                key={box.key}
                type='button'
                className={`gnode gnode--${boxTone(box)}${selected?.entry.threadId === box.entry.threadId && !selected?.node ? ' is-selected' : ''}`}
                style={boxStyle(box)}
                onClick={() => setSelected({ entry: box.entry, node: null })}>
                <span className='gnode-kind'>
                  {box.kind === 'agent' ? (box.entry.agentType ?? 'subagent') : 'session'}
                </span>
                <span className='gnode-title' title={entryLabel(box.entry)}>
                  {entryLabel(box.entry)}
                </span>
                <span className='gnode-sub mono'>
                  {box.entry.threadId.slice(0, 8)} · {box.entry.model ?? '—'}
                </span>
                <span className='gnode-chips'>
                  <span>{fmtInt(box.entry.nodes.length)} steps</span>
                  {box.entry.errors > 0 ? <span className='gchip-error'>{fmtInt(box.entry.errors)} err</span> : null}
                  {isInFlight(box.entry) ? <span className='gchip-flight'>in flight</span> : null}
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

        <div className='graph-toolbar'>
          <span className='graph-status'>
            <span className={`glive${query.isFetching ? ' is-live' : ''}`} aria-hidden />
            {fmtInt(roots.length)} sessions
            {entry ? <span className='muted'> · {fmtInt(entry.nodes.length)} steps</span> : null}
            {bands.length > 0 ? (
              <span className='muted'>
                {' '}
                · {fmtInt(bands.length)} subagents
                {flying > 0 ? <span className='graph-status-flight'> ({fmtInt(flying)} in flight)</span> : null}
              </span>
            ) : null}
            {trails.length > 0 ? (
              <span className='graph-status-cut'> · {fmtInt(trails.length)} interrupted</span>
            ) : null}
          </span>
          <GrainPicker value={grainId} onSelect={setGrainId} />
          <div className='graph-btns'>
            <button type='button' onClick={fit} title={ZOOM_HINT}>
              Fit
            </button>
            <button
              type='button'
              className='graph-icon-btn'
              onClick={() => setRoomy((r) => !r)}
              aria-pressed={roomy}
              aria-label={roomy ? 'Smaller nodes' : 'Larger nodes'}
              title={roomy ? 'Smaller nodes' : "Larger nodes — room for each step's whole text"}>
              {roomy ? <Shrink size={15} aria-hidden /> : <Expand size={15} aria-hidden />}
            </button>
            <button
              type='button'
              className='graph-icon-btn'
              onClick={toggleFull}
              aria-pressed={isFull}
              aria-label={isFull ? 'Exit fullscreen' : 'Fullscreen'}
              title={isFull ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFull ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
            </button>
          </div>
          <div className='graph-legend'>
            {grainId === 'command'
              ? COMMAND_LEGEND.map((family) => (
                  <span key={family} className='glegend-item'>
                    <span
                      className='glegend-dot is-cmd'
                      style={
                        {
                          background: FAMILY_TOKEN[family].fill,
                          '--gc': FAMILY_TOKEN[family].edge,
                        } as CSSProperties
                      }
                    />
                    {FAMILY_LABEL[family]}
                  </span>
                ))
              : (grainId === 'agent' ? AGENT_LEGEND : LEGEND).map((l) => (
                  <span key={l.tone} className='glegend-item'>
                    <span className='glegend-dot' style={{ background: color(l.tone) }} />
                    {l.label}
                  </span>
                ))}
          </div>
        </div>

        {query.error ? <div className='graph-note error'>Failed to load: {(query.error as Error).message}</div> : null}
        {!query.isLoading && all.length === 0 ? (
          <div className='graph-note muted'>No session transcripts yet.</div>
        ) : null}

        <Inspector
          panelRef={inspectorRef}
          selection={selected}
          agent={selected?.node ? agentIndex?.get(selected.entry.threadId)?.get(selected.node.index) : undefined}
          byId={byId}
          sources={sources}
          wide={inspectorWide}
          onToggleWide={() => setInspectorWide((w) => !w)}
          onClose={() => setSelected(null)}
          onFocusAgent={setFocusId}
          onOpenAt={openAt}
        />
      </div>
    </section>
  );
}

/**
 * One placed step. `run` is set only at the command grain and `agent` only at the agent grain,
 * where the box stands for a whole run or agent and carries what it did — steps, tool calls,
 * errors — in place of the folded-away steps.
 */
function CommandOrStepBox({
  box,
  run,
  agent,
  selected,
  onSelect,
}: {
  box: Box;
  run: CommandRunSpan | undefined;
  agent: AgentFacts | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const node = box.node!;
  return (
    <button
      type='button'
      className={`gnode gnode--${boxTone(box)}${run ? ' gnode--cmd' : ''}${cutClass(node)}${selected ? ' is-selected' : ''}`}
      style={boxStyle(box, run)}
      onClick={onSelect}>
      <span className='gnode-kind'>{run ? FAMILY_LABEL[run.family] : agent ? 'agent' : nodeKind(node)}</span>
      <span className='gnode-title' title={run ? commandHover(run) : agent ? agentHover(agent) : hoverLabel(node)}>
        {run ? runLabel(run) : agent ? agentLabel(agent) : nodeLabel(node)}
      </span>
      {run ? (
        <span className='gnode-chips'>
          <span>{fmtInt(run.steps)} steps</span>
          <span>{fmtInt(run.tools)} tools</span>
          {run.errors > 0 ? <span className='gchip-error'>{fmtInt(run.errors)} err</span> : null}
        </span>
      ) : null}
      {agent ? (
        <span className='gnode-chips'>
          {agent.linked ? (
            <>
              <span>{fmtInt(agent.turns.length)} turns</span>
              <span>{fmtInt(agent.tools)} tools</span>
              {agent.errors > 0 ? <span className='gchip-error'>{fmtInt(agent.errors)} err</span> : null}
              {agent.agents > 0 ? <span className='gchip-flight'>{fmtInt(agent.agents)} agents</span> : null}
              {agent.inFlight ? <span className='gchip-flight'>in flight</span> : null}
            </>
          ) : (
            <span className='muted'>no transcript</span>
          )}
        </span>
      ) : null}
    </button>
  );
}

/** What an agent box says on hover: what it was dispatched as, and how much it folds away. */
const agentHover = (agent: AgentFacts): string =>
  agent.linked
    ? `${agentLabel(agent)} — ${agent.turns.length} turns and ${agent.runs.length} command runs folded inside, dispatched at step #${agent.spawnIndex}`
    : `${agentLabel(agent)} — dispatched at step #${agent.spawnIndex}, no transcript captured`;

/** What a command box says on hover: which command, and the span of the transcript it holds. */
const commandHover = (run: CommandRunSpan): string =>
  `${runLabel(run)} — steps #${run.from}–${run.to - 1}${run.host ? ' (the host run, before its first nested command)' : ''}`;

/**
 * The grain switcher: every grain the engine knows about, in order. A grain nobody has
 * built yet is listed but disabled and says so on hover — the control is the seam those
 * views arrive through, so it names them rather than appearing to grow an option later.
 */
function GrainPicker({ value, onSelect }: { value: GrainId; onSelect: (next: GrainId) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own box and legend layout; the toolbar's controls are styled from scratch
    <div className='graph-grains' role='group' aria-label='Detail'>
      {GRAINS.map((g) => {
        const built = isBuilt(g);
        return (
          <button
            key={g.id}
            type='button'
            className={g.id === value ? 'is-on' : undefined}
            aria-pressed={g.id === value}
            disabled={!built}
            title={built ? g.hint : `${g.hint} — not built yet`}
            onClick={() => onSelect(g.id)}>
            {g.label}
          </button>
        );
      })}
    </div>
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
    <aside ref={railRef} className={`graph-sessions${collapsed ? ' is-collapsed' : ''}`} aria-label='Sessions'>
      <div className='gs-head'>
        {collapsed ? null : <span className='gs-title'>Sessions</span>}
        <button
          type='button'
          className='gs-collapse'
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show sessions' : 'Hide sessions'}>
          {collapsed ? '»' : '«'}
        </button>
      </div>
      {collapsed ? (
        <span className='gs-rail-label'>{fmtInt(roots.length)} sessions</span>
      ) : (
        <div className='gs-list'>
          {rows.map(({ entry, depth, childCount, expanded }) => {
            const isAgent = entry.parentThreadId !== null;
            const active = entry.threadId === (isAgent ? focusId : selectedId);
            return (
              <div key={entry.threadId} className='gs-row' style={{ paddingLeft: depth * 14 }}>
                {childCount > 0 ? (
                  <button
                    type='button'
                    className='gs-fold'
                    onClick={() => toggleFold(entry.threadId)}
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Hide subagents' : 'Show subagents'}>
                    {expanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className='gs-fold is-empty' aria-hidden>
                    {isAgent ? '↳' : ''}
                  </span>
                )}
                <button
                  type='button'
                  className={`gs-item${active ? ' is-active' : ''}${isAgent ? ' is-agent' : ''}`}
                  onClick={() => onSelect(entry)}>
                  <span className='gs-item-title'>
                    {isAgent ? <span className='gs-item-type'>{entry.agentType ?? 'subagent'}</span> : null}
                    {entryLabel(entry)}
                  </span>
                  <span className='gs-item-meta mono'>
                    {fmtLocalTsShort(entry.modified)} · {fmtInt(entry.nodes.length)} steps
                    {childCount > 0 ? <span className='gs-item-kids'> · {fmtInt(childCount)} agents</span> : null}
                    {entry.errors > 0 ? <span className='gs-item-err'> · {fmtInt(entry.errors)} err</span> : null}
                    {isInFlight(entry) ? <span className='gs-item-flight'> · in flight</span> : null}
                    {entry.liveness.state === 'finished' ? null : (
                      <span className={`gs-item-live is-${entry.liveness.state}`} title={livenessTitle(entry.liveness)}>
                        {' '}
                        · {entry.liveness.state}
                      </span>
                    )}
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

/**
 * Node details drawer. Transcript lines are one-line gists; the whole text comes
 * from a sidecar fetched per open drawer, empty for sessions captured before the
 * proxy wrote one.
 */
function Inspector({
  panelRef,
  selection,
  agent,
  byId,
  sources,
  wide,
  onToggleWide,
  onClose,
  onFocusAgent,
  onOpenAt,
}: {
  panelRef: Ref<HTMLElement>;
  selection: Selection | null;
  agent: AgentFacts | undefined;
  byId: Map<string, SessionGraphEntry>;
  sources: Map<string, string>;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  onFocusAgent: (id: string) => void;
  onOpenAt: (grain: GrainId, entry: SessionGraphEntry, node: SessionNode | null) => void;
}) {
  if (!selection) return null;
  // Remount per selection so a step opened after the last fetch pulls its own text.
  return (
    <InspectorBody
      key={`${selection.entry.threadId}:${selection.node?.index ?? 'root'}`}
      panelRef={panelRef}
      selection={selection}
      agent={agent}
      byId={byId}
      sources={sources}
      wide={wide}
      onToggleWide={onToggleWide}
      onClose={onClose}
      onFocusAgent={onFocusAgent}
      onOpenAt={onOpenAt}
    />
  );
}

function InspectorBody({
  panelRef,
  selection,
  agent,
  byId,
  sources,
  wide,
  onToggleWide,
  onClose,
  onFocusAgent,
  onOpenAt,
}: {
  panelRef: Ref<HTMLElement>;
  selection: Selection;
  agent: AgentFacts | undefined;
  byId: Map<string, SessionGraphEntry>;
  sources: Map<string, string>;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  onFocusAgent: (id: string) => void;
  onOpenAt: (grain: GrainId, entry: SessionGraphEntry, node: SessionNode | null) => void;
}) {
  const { entry, node } = selection;
  const texts = useQuery({
    queryKey: ['session-node-text', entry.threadId],
    queryFn: () => getSessionNodeTexts(entry.threadId),
  });
  /** The whole text behind step `index`, when the sidecar recorded one. */
  const fullText = (index: number | null): string | undefined =>
    index === null ? undefined : texts.data?.texts[index];

  const source = sources.get(entry.threadId);
  const agentType = node ? spawnAgentType(node) : null;
  const isAgent = !node && entry.parentThreadId !== null;
  const kind = node ? (agentType === null ? node.type : 'spawn') : isAgent ? 'subagent' : 'session';
  const kindColor = color(node ? (agentType === null ? node.type : 'agent') : isAgent ? 'agent' : 'root');
  const parent = entry.parentThreadId ? byId.get(entry.parentThreadId) : undefined;
  /** For a spawn step, the subagent it started. */
  const spawned = node
    ? [...byId.values()].find((s) => s.parentThreadId === entry.threadId && s.spawnIndex === node.index)
    : undefined;

  return (
    <aside ref={panelRef} className={`graph-inspector${wide ? ' is-wide' : ''}`} aria-label='Node details'>
      <div className='gi-head'>
        <span className='gi-kind' style={{ '--gc': kindColor } as CSSProperties}>
          {kind}
        </span>
        <div className='gi-actions'>
          <button
            type='button'
            className='gi-wide'
            onClick={onToggleWide}
            aria-expanded={wide}
            title={wide ? 'Narrow the drawer' : 'Widen the drawer'}>
            {wide ? '⇥' : '⇤'}
          </button>
          <button type='button' className='gi-close' onClick={onClose} aria-label='Close'>
            ×
          </button>
        </div>
      </div>

      <div className='gi-body'>
        {node ? (
          <>
            {node.task ? (
              <Field label='Task'>
                <ExpandableText
                  key={`t:${entry.threadId}:${node.index}`}
                  text={node.task}
                  full={fullText(taskIndexFor(entry.nodes, node))}
                />
              </Field>
            ) : null}
            {node.tool ? (
              <Field label='Tool'>
                <LongText key={`c:${entry.threadId}:${node.index}`} text={node.tool} mono />
              </Field>
            ) : null}
            <Field label='Detail'>
              <ExpandableText
                key={`d:${entry.threadId}:${node.index}`}
                text={node.text || '—'}
                full={fullText(node.index)}
              />
            </Field>
            <Field label='Step'>#{node.index}</Field>
            {source && node.message !== null ? <RequestMessage file={source} index={node.message} /> : null}
            {node.interrupted ? (
              <Field label='Cut off'>
                <span className='gi-cut'>the run was interrupted here — it picks up on the trail below</span>
              </Field>
            ) : null}
            {node.interruption ? (
              <Field label='Resumed after'>
                <span className='gi-cut'>{interruptionLabel(node.interruption)}</span>
              </Field>
            ) : null}
            {agent?.child ? <AgentFold agent={agent} child={agent.child} onOpenAt={onOpenAt} /> : null}
            {agentType === null ? null : spawned ? (
              <>
                <Field label='Subagent'>{entryLabel(spawned)}</Field>
                <Field label='Status'>{agentStatus(spawned)}</Field>
                <button type='button' className='link gi-open' onClick={() => onFocusAgent(spawned.threadId)}>
                  Show its branch →
                </button>
              </>
            ) : (
              <Field label='Subagent'>
                <span className='muted'>no transcript captured</span>
              </Field>
            )}
          </>
        ) : (
          <>
            {isAgent ? (
              <>
                <Field label='Agent type'>{entry.agentType ?? '—'}</Field>
                <Field label='Status'>{agentStatus(entry)}</Field>
                <Field label='Spawned by'>{parent ? `${entryLabel(parent)} · step #${entry.spawnIndex}` : '—'}</Field>
              </>
            ) : null}
            <Field label='First task'>
              <ExpandableText text={entry.firstTask ?? '—'} full={fullText(firstTaskIndex(entry.nodes))} />
            </Field>
            <div className='gi-stats'>
              <Stat label='tasks' value={entry.tasks} />
              <Stat label='tools' value={entry.tools} />
              <Stat label='errors' value={entry.errors} tone={entry.errors > 0 ? 'bad' : undefined} />
            </div>
          </>
        )}
        <Field label='Session'>
          <span className='mono-break'>{entry.threadId}</span>
        </Field>
        <Field label='Model'>{entry.model ?? '—'}</Field>
        {entry.started ? <Field label='Started'>{fmtLocalTsShort(entry.started)}</Field> : null}
        <Field label='Updated'>{fmtLocalTsShort(entry.modified)}</Field>
        <Link to='/sessions/$id' params={{ id: entry.threadId }} className='link gi-open'>
          Open transcript →
        </Link>
        {source ? (
          <>
            {node && node.message !== null ? (
              <Link
                to='/context/$file/message/$index'
                params={{ file: source, index: String(node.message) }}
                className='link gi-open'>
                Open this step's message →
              </Link>
            ) : null}
            <Link to='/context/$file' params={{ file: source }} className='link gi-open'>
              Open request breakdown →
            </Link>
            {node && node.message === null ? (
              <span className='gi-note muted'>
                This step pairs with nothing in the captured request, so its text is the transcript's gist.
              </span>
            ) : null}
          </>
        ) : (
          <span className='gi-note muted'>Text from the transcript — no captured request matched.</span>
        )}
      </div>
    </aside>
  );
}

/**
 * The turn a step was read out of, whole — the same message the Request breakdown's drill-down
 * shows, rather than the one line the step stream keeps of it. Fetched per open drawer and
 * clamped like any other long value; a request that has since rotated away omits the field.
 */
function RequestMessage({ file, index }: { file: string; index: number }) {
  const query = useQuery({
    queryKey: ['context-message', file, index],
    queryFn: () => getContextMessage(file, index),
  });
  // An evicted body has no message; the drawer omits the field, as for a rotated-away request.
  const message = query.data && !query.data.evicted ? query.data.message : undefined;
  if (!message) return null;
  return (
    <Field label='Request message'>
      <span className='gi-note muted'>
        #{fmtInt(message.index + 1)} of {fmtInt(message.messageCount)} · {message.role}
      </span>
      <LongText key={`m:${file}:${index}`} text={message.content} mono />
    </Field>
  );
}

/**
 * What one agent box folded away: the turns it took and the commands it ran. Each row redraws
 * the canvas at the grain that draws that thing and opens it there.
 */
function AgentFold({
  agent,
  child,
  onOpenAt,
}: {
  agent: AgentFacts;
  child: SessionGraphEntry;
  onOpenAt: (grain: GrainId, entry: SessionGraphEntry, node: SessionNode | null) => void;
}) {
  return (
    <>
      <Field label={`Its turns · ${fmtInt(agent.turns.length)}`}>
        <FoldList
          empty='no turns recorded'
          rows={agent.turns.map((node) => ({
            key: `t${node.index}`,
            lead: `#${node.index}`,
            label: nodeLabel(node),
            onOpen: () => onOpenAt(TURN_GRAIN.id, child, node),
          }))}
        />
      </Field>
      <Field label={`Its commands · ${fmtInt(agent.runs.length)}`}>
        <FoldList
          empty='no command runs'
          rows={agent.runs.map((run) => ({
            key: `c${run.from}`,
            lead: FAMILY_LABEL[run.family],
            label: `${runLabel(run)} · ${fmtInt(run.steps)} steps`,
            onOpen: () => onOpenAt('command', child, child.nodes.find((n) => n.index === run.from) ?? null),
          }))}
        />
      </Field>
    </>
  );
}

/** One row of a fold: what it is, what it says, and the view it opens in. */
interface FoldRow {
  key: string;
  lead: string;
  label: string;
  onOpen: () => void;
}

/** Rows shown before a fold asks to be opened — an agent's turns run to the hundreds. */
const FOLD_ROWS = 18;

function FoldList({ rows, empty }: { rows: FoldRow[]; empty: string }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return <span className='muted'>{empty}</span>;
  const shown = open ? rows : rows.slice(0, FOLD_ROWS);

  return (
    <>
      <ul className='gi-fold'>
        {shown.map((row) => (
          <li key={row.key}>
            <button type='button' className='gi-fold-row' onClick={row.onOpen} title={row.label}>
              <span className='gi-fold-lead mono'>{row.lead}</span>
              <span className='gi-fold-label'>{row.label}</span>
              <span className='gi-fold-go' aria-hidden>
                →
              </span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > FOLD_ROWS ? (
        <button type='button' className='link gi-more' onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Show fewer' : `Show all ${fmtInt(rows.length)}`}
        </button>
      ) : null}
    </>
  );
}

/** Whether a subagent is still running, or which parent step its result flowed into. */
function agentStatus(agent: SessionGraphEntry): ReactNode {
  return agent.returnIndex === null ? (
    <span className='gi-flight'>in flight — the parent hasn't stepped past the spawn</span>
  ) : (
    <>returned into parent step #{agent.returnIndex}</>
  );
}

/** The step whose `## Task:` heading a node falls under — where that task's whole text lives. */
function taskIndexFor(nodes: SessionNode[], node: SessionNode): number | null {
  if (node.type === 'task') return node.index;
  let found: number | null = null;
  for (const n of nodes) {
    if (n.index >= node.index) break;
    if (n.type === 'task') found = n.index;
  }
  return found;
}

const firstTaskIndex = (nodes: SessionNode[]): number | null => nodes.find((n) => n.type === 'task')?.index ?? null;

/**
 * A gist plus the whole text the transcript line cut short, when the sidecar recorded one.
 * The fuller text is what gets rendered; {@link LongText} keeps it from flooding the drawer.
 *
 * The command envelope comes off first: the tags are stripped and the arguments they wrap
 * are kept. Text carrying no envelope is unaffected.
 */
function ExpandableText({ text, full }: { text: string; full?: string }) {
  const whole = full !== undefined && full.trim() !== '' ? full : text;
  return <LongText text={stripCommandEnvelope(whole)} />;
}

/** Past this much text a value is folded away until asked for. */
const LONG_TEXT_CHARS = 280;

/**
 * A value that may run long — request-derived steps carry whole prompts and command lines.
 * Short ones render plainly; long ones clamp behind a toggle. Give it a key tied to the step,
 * so opening one doesn't open the next.
 */
function LongText({ text, mono }: { text: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT_CHARS;
  // Opened, it scrolls within the drawer rather than pushing the fields below it off-screen.
  const cls = `gi-text${mono ? ' mono-break' : ''}${long ? (open ? ' is-full' : ' is-clamped') : ''}`;

  return (
    <>
      <p className={cls}>{text}</p>
      {long ? (
        <button type='button' className='link gi-more' onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Show less' : `Show all ${fmtInt(text.length)} characters`}
        </button>
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='gi-field'>
      <span className='gi-label'>{label}</span>
      <div className='gi-value'>{children}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div className='gi-stat'>
      <span className={`gi-stat-value${tone === 'bad' ? ' gi-stat-bad' : ''}`}>{fmtInt(value)}</span>
      <span className='gi-stat-label'>{label}</span>
    </div>
  );
}

/** `?session=` names the session the graph opens on. */
export interface SessionGraphSearch {
  session?: string;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/graph',
  component: SessionGraphPage,
  staticData: { title: 'Live graph' },
  validateSearch: (search: Record<string, unknown>): SessionGraphSearch => {
    const session = search.session;
    return typeof session === 'string' && session !== '' ? { session } : {};
  },
});

export const nav = {
  section: 'Sessions',
  to: '/sessions/graph',
  label: 'Live graph',
  hint: 'sessions',
  exact: false,
  icon: Network,
} as const satisfies NavEntry;
