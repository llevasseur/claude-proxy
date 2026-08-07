import type { SessionPoint } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { getSessionEmbedding } from '../api';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonStats } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtInt, fmtLocalTsShort } from '../format';

/**
 * "Session map" — every session transcript as one dot on a flat embedding projection.
 *
 * **Position is the whole claim**: two dots near each other are two sessions about the same
 * subject. The axes are not quantities and there are deliberately no edges — the
 * [live graph](/sessions/graph) draws parent/subagent, and an edge here would read as a stronger
 * claim than proximity supports.
 *
 * Dots are coloured by the slash command that ran each session, which is the question the page
 * answers: whether runs of one command cluster or scatter across subjects. That only means
 * something because the command's inlined definition is stripped before embedding — see
 * `packages/core/src/embedding.ts`.
 */
export function SessionMapPage() {
  const query = useQuery({ queryKey: ['session-embedding'], queryFn: () => getSessionEmbedding() });
  const data = query.data;
  /** Commands the legend has switched off. Hiding one re-reads the map without re-projecting it. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const bands = useMemo(() => {
    if (!data) return [];
    return data.commands.map((band, i) => ({
      ...band,
      color: bandColor(band.command, i),
      key: bandKey(band.command),
      points: data.points.filter((p) => p.command === band.command),
    }));
  }, [data]);

  return (
    <section>
      <div className='pagehead'>
        <h1>Session map</h1>
        <div className='muted'>
          Every session transcript as a dot, positioned by what it was about — sessions on the same subject sit
          together. Coloured by the command that ran it.
        </div>
      </div>

      <div className='card' style={{ marginBottom: 16 }}>
        <div className='leak-note'>
          <strong>Position is the only claim.</strong> Each transcript becomes one embedding vector, and t-SNE reduces
          those to two dimensions. The axes are not quantities and there are no edges — distance between two dots is a
          statement about how similar their subjects are, and nothing else on this page means anything. Distances are
          meaningful <em>locally</em>: which dots are neighbours is reliable, while the size of the gaps between
          far-apart clusters is not.
        </div>
        <div className='leak-note'>
          <strong>The colouring is an observation, not the layout.</strong> A command's inlined definition is stripped
          before its session is embedded, so runs of one command share none of that boilerplate. Whether{' '}
          <span className='rule-name'>/task</span> runs cluster together or spread across the map is therefore something
          you can read off it, rather than something the projection was told.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SessionMapSkeleton />}>
        {!data ? null : data.points.length === 0 ? (
          <div className='card empty'>
            {data.meta.skipped > 0 ? (
              <>
                All {fmtInt(data.meta.skipped)} transcript{data.meta.skipped === 1 ? '' : 's'} in{' '}
                <span className='rule-name'>{data.meta.sessionsDir}</span> carried no usable text, so there is nothing
                to place — {fmtInt(data.meta.total)} on disk, none with a subject to position it by.
              </>
            ) : (
              <>
                No session transcripts in <span className='rule-name'>{data.meta.sessionsDir}</span> yet. The map fills
                as the proxy writes them.
              </>
            )}
          </div>
        ) : (
          <>
            <div className='grid stats'>
              <StatCard label='Sessions' value={fmtInt(data.meta.sessions)} sub='placed on the map' />
              <StatCard label='Commands' value={fmtInt(data.commands.length)} sub='distinct, including none' />
              <StatCard label='Vocabulary' value={fmtInt(data.meta.vocabulary)} sub='terms behind the vectors' />
              <StatCard
                label='Skipped'
                value={fmtInt(data.meta.skipped)}
                sub={data.meta.skipped === 0 ? 'every transcript placed' : 'no usable text'}
              />
            </div>

            {data.meta.vocabulary === 0 && (
              <div className='card mapwarn' style={{ marginBottom: 16 }}>
                <div className='leak-note'>
                  <strong>Position means nothing on this map.</strong> No term survived the vocabulary filter, so every
                  vector is empty and every pair of sessions is exactly as far apart as every other. The dots below are
                  laid out by the projection's own dynamics, not by subject — read nothing into which sit together.
                </div>
              </div>
            )}

            <MapLegend bands={bands} hidden={hidden} onToggle={setHidden} />
            <MapCanvas bands={bands} hidden={hidden} />

            <div className='card'>
              <div className='card-head'>
                <h2>How this map was built</h2>
                <span className='muted'>same transcripts in, same map out</span>
              </div>
              <div className='leak-note'>
                {fmtInt(data.meta.sessions)} transcripts from <span className='rule-name'>{data.meta.sessionsDir}</span>
                {data.meta.total > data.meta.sessions + data.meta.skipped && (
                  <> (the newest of {fmtInt(data.meta.total)}; the layout is O(n²), so the window is capped)</>
                )}
                , vectorised over a {fmtInt(data.meta.vocabulary)}-term vocabulary, reduced by t-SNE at perplexity{' '}
                {data.meta.perplexity.toFixed(1)} over {fmtInt(data.meta.iterations)} iterations from seed{' '}
                {data.meta.seed}. The projection is pure and seeded, so the map only moves when the transcripts do.
                {data.meta.skipped > 0 && (
                  <>
                    {' '}
                    {fmtInt(data.meta.skipped)} transcript{data.meta.skipped === 1 ? '' : 's'} carried no usable text
                    and {data.meta.skipped === 1 ? 'was' : 'were'} left off rather than parked at the origin, which
                    would have invented a position for {data.meta.skipped === 1 ? 'it' : 'them'}.
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

/** One command's dots, ready to draw. */
interface Band {
  command: string | null;
  sessions: number;
  color: string;
  key: string;
  points: SessionPoint[];
}

/**
 * The dot palette: the theme's signal colours first, then further hues that stay distinguishable
 * on the dark surface. A command past the end wraps, so with enough commands a pair shares a
 * colour and the tooltip disambiguates.
 */
const PALETTE = [
  'var(--signal)',
  'var(--amber)',
  'var(--violet)',
  'var(--good)',
  'var(--coral)',
  '#5aa9f4',
  '#f48ad0',
  '#c9e35a',
  '#5ae0e0',
  '#b98cff',
];

/** Ordinary sessions are the absence of a command, so they take the theme's faint tone, not a hue. */
const NO_COMMAND_COLOR = 'var(--faint)';

function bandColor(command: string | null, index: number): string {
  if (command === null) return NO_COMMAND_COLOR;
  return PALETTE[index % PALETTE.length]!;
}

/** A stable React/scatter key for a band, since the ordinary-session band has no name. */
function bandKey(command: string | null): string {
  return command ?? ' none';
}

/** How a band is labelled in the legend and the tooltip. */
function bandLabel(command: string | null): string {
  return command === null ? 'no command' : `/${command}`;
}

function MapLegend({
  bands,
  hidden,
  onToggle,
}: {
  bands: Band[];
  hidden: ReadonlySet<string>;
  onToggle: (next: ReadonlySet<string>) => void;
}) {
  const toggle = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onToggle(next);
  };

  return (
    <div className='card' style={{ marginBottom: 16 }}>
      <div className='card-head'>
        <h2>Commands</h2>
        <span className='muted'>click to show or hide a command's sessions</span>
      </div>
      <div className='maplegend'>
        {bands.map((band) => {
          const off = hidden.has(band.key);
          return (
            <button
              key={band.key}
              type='button'
              className={`maplegend-chip${off ? ' is-off' : ''}`}
              onClick={() => toggle(band.key)}
              aria-pressed={!off}
              title={off ? `Show ${bandLabel(band.command)}` : `Hide ${bandLabel(band.command)}`}>
              <span className='maplegend-dot' style={{ background: band.color }} />
              <span className='maplegend-name'>{bandLabel(band.command)}</span>
              <span className='maplegend-count'>{fmtInt(band.sessions)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Padding around the projection's [-1, 1] range, so a dot on the edge isn't clipped. */
const AXIS_PAD = 0.08;

function MapCanvas({ bands, hidden }: { bands: Band[]; hidden: ReadonlySet<string> }) {
  const navigate = useNavigate();
  const shown = bands.filter((b) => !hidden.has(b.key));
  const plotted = shown.reduce((n, b) => n + b.points.length, 0);
  // The tooltip gets a point, not its band, so the swatch colour is looked up by band key.
  const colors = new Map(bands.map((b) => [b.key, b.color]));

  return (
    <div className='card' style={{ marginBottom: 16 }}>
      <div className='card-head'>
        <h2>
          {fmtInt(plotted)} session{plotted === 1 ? '' : 's'}
        </h2>
        <span className='muted'>hover a dot for its session · click to open the transcript</span>
      </div>
      {plotted === 0 ? (
        <div className='empty'>Every command is hidden — switch one back on above.</div>
      ) : (
        <div style={{ height: 560 }}>
          <ResponsiveContainer width='100%' height='100%'>
            <ScatterChart margin={{ top: 12, right: 16, bottom: 12, left: 16 }}>
              <CartesianGrid strokeDasharray='3 3' stroke='var(--line)' />
              {/* The axes carry no unit, so ticks are hidden — a number would invite reading a
                  quantity off a position that has none. */}
              <XAxis
                type='number'
                dataKey='x'
                domain={[-1 - AXIS_PAD, 1 + AXIS_PAD]}
                tick={false}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type='number'
                dataKey='y'
                domain={[-1 - AXIS_PAD, 1 + AXIS_PAD]}
                tick={false}
                axisLine={false}
                tickLine={false}
              />
              {/* Fixed dot size — nothing on this map encodes magnitude. */}
              <ZAxis range={[46, 46]} />
              <Tooltip content={<PointTooltip colors={colors} />} />
              {shown.map((band) => (
                <Scatter
                  key={band.key}
                  name={bandLabel(band.command)}
                  data={band.points}
                  fill={band.color}
                  fillOpacity={0.78}
                  stroke={band.color}
                  isAnimationActive={false}
                  onClick={(entry: unknown) => {
                    // recharts hands a click either the datum's own fields or a `payload` wrapper
                    // depending on the shape it hit, so read the thread id from both.
                    const node = entry as { threadId?: string; payload?: { threadId?: string } } | undefined;
                    const id = node?.threadId ?? node?.payload?.threadId;
                    if (id) navigate({ to: '/sessions/$id', params: { id } });
                  }}
                  style={{ cursor: 'pointer' }}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

interface TooltipProps {
  /** Band key → dot colour, so the swatch matches the dot actually hovered. */
  colors?: ReadonlyMap<string, string>;
  // Both are injected by recharts, which clones this element with the hovered payload.
  active?: boolean;
  payload?: { payload?: SessionPoint }[];
}

/** Names the session and the command that ran it, plus the terms that pinned it where it is. */
function PointTooltip({ colors, active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const color = colors?.get(bandKey(point.command)) ?? NO_COMMAND_COLOR;
  return (
    <div className='charttip maptip'>
      <div className='charttip-label'>{point.name}</div>
      <div className='charttip-row'>
        <span className='charttip-dot' style={{ background: color }} />
        <span className='charttip-name'>{bandLabel(point.command)}</span>
        <span className='charttip-value'>{point.model ?? 'unknown model'}</span>
      </div>
      {point.terms.length > 0 && <div className='maptip-terms'>{point.terms.join(' · ')}</div>}
      <div className='maptip-foot'>
        {fmtInt(point.tasks)} task{point.tasks === 1 ? '' : 's'} · {fmtInt(point.tools)} tool
        {point.tools === 1 ? '' : 's'}
        {point.errors > 0 && <> · {fmtInt(point.errors)} failed</>}
        {point.started && <> · {fmtLocalTsShort(point.started)}</>}
      </div>
    </div>
  );
}

function SessionMapSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <div className='card' style={{ marginBottom: 16 }}>
        <div className='card-head'>
          <Skeleton w='18%' h='0.95em' />
          <Skeleton w='30%' />
        </div>
        <div className='maplegend'>
          {['a', 'b', 'c', 'd', 'e'].map((k) => (
            <Skeleton key={k} w='86px' h='26px' />
          ))}
        </div>
      </div>
      <div className='card' style={{ marginBottom: 16 }}>
        <div className='card-head'>
          <Skeleton w='22%' h='0.95em' />
          <Skeleton w='36%' />
        </div>
        {/* Reserves the plot's exact height, so the panels below do not jump when data lands. */}
        <Skeleton w='100%' h='560px' />
      </div>
    </>
  );
}
