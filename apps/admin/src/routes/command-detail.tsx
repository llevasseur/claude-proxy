import type { CommandRunOutcome, CommandStep, StepReach } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { type CommandResponse, type CommandRunListItem, getCommand } from '../api';
import { Frontmatter, splitFrontmatter } from '../components/Frontmatter';
import { HeaderHint } from '../components/HeaderHint';
import { LiveIndicator } from '../components/LiveIndicator';
import { Markdown } from '../components/Markdown';
import { QueryState } from '../components/QueryState';
import { PRETTY_RAW, type PrettyRawView, Segmented } from '../components/Segmented';
import { type Series, SeriesLineChart } from '../components/SeriesLineChart';
import {
  Skeleton,
  SkeletonChartCard,
  type SkeletonColumn,
  SkeletonStats,
  SkeletonTableCard,
  SkeletonText,
} from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtCompact, fmtDuration, fmtInt, fmtLocalTs, fmtLocalTsShort, fmtPct, fmtUsd } from '../format';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';

/** One colour per outcome, shared by the scatter, its legend and the run list. */
const OUTCOME_COLOR: Record<CommandRunOutcome, string> = {
  completed: 'var(--good)',
  interrupted: 'var(--amber)',
  errored: 'var(--coral)',
  running: 'var(--signal)',
};

const OUTCOME_ORDER: CommandRunOutcome[] = ['completed', 'interrupted', 'errored', 'running'];

/** The unattributed bucket's colour — deliberately distinct from any step's. */
const UNATTRIBUTED_COLOR = 'var(--faint)';
/** Step colours, cycled. */
const STEP_COLORS = ['var(--signal)', 'var(--good)', 'var(--amber)', 'var(--violet)', 'var(--coral)'];

function stepColor(step: string | null, index: number): string {
  return step === null ? UNATTRIBUTED_COLOR : STEP_COLORS[index % STEP_COLORS.length]!;
}

/**
 * One command's runs — cost and shape over time, where runs stop, and what goes wrong.
 *
 * The scatter is the primary view because the question is distributional: what a run of
 * this command costs is a spread, not one number, and the spread is the finding. Nothing
 * here is normalized by files touched or diff size.
 */
export function CommandDetailPage() {
  const { command } = useParams({ from: '/commands/$command' });
  const [flags, setFlags] = useState<string[]>([]);
  const key = ['command', command, flags.join(',')];
  const query = useQuery({ queryKey: key, queryFn: () => getCommand(command, flags) });
  const streamPath = `/api/commands/command/stream?name=${encodeURIComponent(command)}${
    flags.length ? `&flags=${encodeURIComponent(flags.join(','))}` : ''
  }`;
  const live = useLiveQuery<CommandResponse>(streamPath, key);
  const data = query.data;

  const toggleFlag = (flag: string) =>
    setFlags((prev) => (prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag].sort()));

  return (
    <section>
      <div className='pagehead'>
        <h1>/{command}</h1>
        <div className='muted'>
          <Link to='/commands' className='link'>
            All commands
          </Link>
          {data && !data.installed && <> · this command is no longer installed; its history is kept</>}
        </div>
      </div>

      <div className='card-head' style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        <LiveIndicator status={live} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<CommandDetailSkeleton />}>
        {!data ? null : data.meta.totalRuns === 0 ? (
          <>
            <div className='card empty'>
              No runs of <span className='rule-name'>/{command}</span> captured yet. It has{' '}
              {data.steps.length === 0 ? 'no declared steps' : `${data.steps.length} declared steps`}; numbers appear
              the next time it actually runs through the proxy.
            </div>
            <CommandFile source={data.source} command={command} />
          </>
        ) : (
          <CommandBody data={data} command={command} flags={flags} onToggleFlag={toggleFlag} />
        )}
      </QueryState>
    </section>
  );
}

/** The scatter's fixed height, read by the chart and its placeholder alike. */
const SCATTER_HEIGHT = 300;

const STEP_COLUMNS: SkeletonColumn[] = [
  { cell: '56%' },
  { className: 'num', cell: '40%' },
  { className: 'num', cell: '48%' },
  { className: 'num', cell: '40%' },
  { className: 'num', cell: '36%' },
];

const PATTERN_COLUMNS: SkeletonColumn[] = [
  { cell: '64%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '34%' },
];

const RUN_COLUMNS: SkeletonColumn[] = [
  { cell: '58%' },
  { cell: '82%' },
  { cell: '40%' },
  { cell: '48%' },
  { className: 'num', cell: '36%' },
  { className: 'num', cell: '32%' },
  { className: 'num', cell: '48%' },
  { className: 'num', cell: '40%' },
];

/** `CommandBody`'s cards in the order it lays them out; the optional flags card is not reserved. */
function CommandDetailSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='22%' h='0.95em' />
          <Skeleton w='7rem' />
        </div>
        <SkeletonText lines={9} />
      </div>
      <SkeletonChartCard title='Runs over time' height={SCATTER_HEIGHT} bars={18} />
      <SkeletonChartCard title='Steps per run' height={TREND_HEIGHT} bars={18} legend={WORK_SERIES.length} />
      <SkeletonChartCard title='Time per run' height={TREND_HEIGHT} bars={18} legend={TIME_SERIES.length} />
      <SkeletonTableCard title='Tokens by step' columns={STEP_COLUMNS} rows={6} />
      <SkeletonTableCard title='Patterns' columns={PATTERN_COLUMNS} rows={4} />
      <SkeletonTableCard title='Runs' columns={RUN_COLUMNS} rows={8} />
    </>
  );
}

function CommandBody({
  data,
  command,
  flags,
  onToggleFlag,
}: {
  data: CommandResponse;
  command: string;
  flags: string[];
  onToggleFlag: (flag: string) => void;
}) {
  /** Which run's step breakdown the stacked bar shows; null is the aggregate. */
  const [hoverRun, setHoverRun] = useState<CommandRunListItem | null>(null);

  const runs = data.runs;
  const settled = runs.filter((r) => r.outcome !== 'running');
  const completed = settled.filter((r) => r.reachedEnd).length;
  const cost = runs.reduce((n, r) => n + r.totals.cost, 0);
  const tokens = runs.reduce((n, r) => n + r.totals.tokens.realInput + r.totals.tokens.output, 0);

  return (
    <>
      <div className='grid stats'>
        <StatCard
          label='Runs'
          value={fmtInt(data.meta.filteredRuns)}
          sub={data.meta.filteredRuns === data.meta.totalRuns ? 'all captured' : `of ${data.meta.totalRuns} captured`}
        />
        <StatCard
          label='Reached the end'
          value={settled.length === 0 ? '—' : fmtPct((completed / settled.length) * 100)}
          sub={`${completed} of ${settled.length} settled`}
        />
        <StatCard label='Spent' value={fmtUsd(cost)} sub='across these runs' />
        <StatCard
          label='Median run'
          value={runs.length === 0 ? '—' : fmtUsd(median(runs.map((r) => r.totals.cost)))}
          sub={`${fmtInt(tokens)} tokens in total`}
        />
      </div>

      {data.flags.length > 0 && (
        <div className='card'>
          <div className='card-head'>
            <h2>Flags</h2>
            <span className='muted'>narrows which runs are aggregated — it does not split the command</span>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own box and legend layout; this control is styled from scratch */}
          <div className='segmented' role='group' aria-label='Filter runs by flag'>
            {data.flags.map((flag) => (
              <button
                key={flag}
                type='button'
                className={flags.includes(flag) ? 'active' : undefined}
                aria-pressed={flags.includes(flag)}
                onClick={() => onToggleFlag(flag)}>
                {fmtFlag(flag)}
              </button>
            ))}
          </div>
          {flags.length > 0 && (
            <div className='muted' style={{ marginTop: 8 }}>
              Showing runs that carried {flags.map(fmtFlag).join(' and ')} — {data.meta.filteredRuns} of{' '}
              {data.meta.totalRuns}.
            </div>
          )}
        </div>
      )}

      <CommandFile source={data.source} command={command} />
      <RunScatter data={data} command={command} />
      <ShapeTrends data={data} />
      <StepBar steps={data.steps} reach={data.stepReach} run={hoverRun} totalRuns={data.meta.filteredRuns} />
      <PatternTable data={data} />
      <RunList runs={runs} command={command} onHover={setHoverRun} />
    </>
  );
}

/**
 * The command file itself: Pretty renders the markdown as installed, Raw is the file byte
 * for byte. Nothing here is reconstructed from the parsed step catalogue.
 */
function CommandFile({ source, command }: { source: string | null; command: string }) {
  const [view, setView, isSwitching] = useTransitionState<PrettyRawView>('pretty');

  if (source === null) {
    return (
      <div className='card empty'>
        <span className='rule-name'>/{command}</span> is no longer installed, so there is no file left to show — the
        runs below are all that remains of it.
      </div>
    );
  }

  const { frontmatter, body } = splitFrontmatter(source);

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Command file</h2>
        <Segmented options={PRETTY_RAW} value={view} onSelect={setView} label='Command file view' busy={isSwitching} />
      </div>
      <div className={isSwitching ? 'is-stale' : undefined}>
        {view === 'pretty' ? (
          <div className='file-pretty cmdfile'>
            {frontmatter && <Frontmatter fm={frontmatter} />}
            <Markdown source={body} />
          </div>
        ) : (
          <pre className='rawjson wrap'>{source}</pre>
        )}
      </div>
    </div>
  );
}

interface ScatterPoint {
  x: number;
  y: number;
  z: number;
  runId: string;
  started: string | null;
  cost: number;
  turns: number;
  outcome: CommandRunOutcome;
  flags: string[];
}

/**
 * Cost and shape over time. x is when the run started, y its total tokens, colour the
 * outcome, size the number of turns. A vertical rule marks each point at which the
 * command file's content changed, so a before/after is readable without any tagging.
 */
function RunScatter({ data, command }: { data: CommandResponse; command: string }) {
  const navigate = useNavigate();
  const points: ScatterPoint[] = data.runs
    .filter((r) => r.started !== null)
    .map((r) => ({
      x: new Date(r.started as string).getTime(),
      y: r.totals.tokens.realInput + r.totals.tokens.output,
      z: Math.max(1, r.totals.turns),
      runId: r.runId,
      started: r.started,
      cost: r.totals.cost,
      turns: r.totals.turns,
      outcome: r.outcome,
      flags: r.flags,
    }));

  if (points.length === 0) {
    return (
      <div className='card empty'>
        No run in this selection has a captured request, so there is nothing to plot. The runs are still listed below.
      </div>
    );
  }

  const byOutcome = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    points: points.filter((p) => p.outcome === outcome),
  })).filter((g) => g.points.length > 0);

  const markers = data.hashMarkers.filter((m) => m.previous !== null);

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Runs over time</h2>
        <span className='muted'>y = tokens · size = turns · click a run to open it</span>
      </div>
      <div style={{ height: 300 }}>
        <ResponsiveContainer width='100%' height='100%'>
          {/* Off: recharts otherwise marks the surface `tabIndex=0`, ringing the whole plot. */}
          <ScatterChart accessibilityLayer={false} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray='3 3' stroke='var(--line)' />
            <XAxis
              type='number'
              dataKey='x'
              domain={['dataMin', 'dataMax']}
              scale='time'
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => fmtLocalTsShort(new Date(v).toISOString())}
              minTickGap={40}
            />
            <YAxis
              type='number'
              dataKey='y'
              width='auto'
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtCompact}
            />
            <ZAxis type='number' dataKey='z' range={[30, 320]} />
            <Tooltip cursor={{ stroke: 'var(--line)' }} content={<ScatterTooltip />} />
            {markers.map((m) => (
              <ReferenceLine
                key={`${m.at}-${m.hash}`}
                x={new Date(m.at).getTime()}
                stroke='var(--violet)'
                strokeDasharray='4 3'
                label={{ value: 'edited', fill: 'var(--violet)', fontSize: 10, position: 'top' }}
              />
            ))}
            {byOutcome.map((g) => (
              <Scatter
                key={g.outcome}
                name={g.outcome}
                data={g.points}
                fill={OUTCOME_COLOR[g.outcome]}
                fillOpacity={0.7}
                isAnimationActive={false}
                onClick={(p: unknown) =>
                  navigate({
                    to: '/commands/$command/$runId',
                    params: { command, runId: (p as ScatterPoint).runId },
                  })
                }
                style={{ cursor: 'pointer' }}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className='chartlegend'>
        {byOutcome.map((g) => (
          <span className='chartlegend-item' key={g.outcome}>
            <span className='charttip-dot' style={{ background: OUTCOME_COLOR[g.outcome] }} /> {g.outcome} (
            {g.points.length})
          </span>
        ))}
        {markers.length > 0 && (
          <span className='chartlegend-item'>
            <span className='charttip-dot' style={{ background: 'var(--violet)' }} /> command file edited (
            {markers.length})
          </span>
        )}
      </div>
    </div>
  );
}

function ScatterTooltip({ active, payload }: { active?: boolean; payload?: { payload?: ScatterPoint }[] }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className='charttip'>
      <div className='charttip-label'>{p.started ? fmtLocalTs(p.started) : '—'}</div>
      <div className='charttip-row'>
        <span className='charttip-name'>tokens</span>
        <span className='charttip-value'>{fmtInt(p.y)}</span>
      </div>
      <div className='charttip-row'>
        <span className='charttip-name'>cost</span>
        <span className='charttip-value'>{fmtUsd(p.cost)}</span>
      </div>
      <div className='charttip-row'>
        <span className='charttip-name'>turns</span>
        <span className='charttip-value'>{fmtInt(p.turns)}</span>
      </div>
      <div className='charttip-row'>
        <span className='charttip-name'>outcome</span>
        <span className='charttip-value'>{p.outcome}</span>
      </div>
      {p.flags.length > 0 && (
        <div className='charttip-row'>
          <span className='charttip-name'>flags</span>
          <span className='charttip-value'>{p.flags.map(fmtFlag).join(' ')}</span>
        </div>
      )}
    </div>
  );
}

/** Three readings of "how many steps" a run takes, plotted together because they diverge. */
const WORK_SERIES: Series[] = [
  { dataKey: 'nodes', name: 'agent steps', color: 'var(--signal)' },
  { dataKey: 'toolCalls', name: 'tool calls', color: 'var(--violet)' },
  { dataKey: 'stepsReached', name: 'declared steps reached', color: 'var(--good)' },
];

const TIME_SERIES: Series[] = [{ dataKey: 'endToEndMs', name: 'end to end', color: 'var(--amber)' }];

/** Both trend charts share this height, and the skeleton reserves it. */
const TREND_HEIGHT = 220;

/**
 * How much work each run did, and how long it took, run by run.
 *
 * Two charts rather than two axes: step counts in the low tens and a duration in the
 * millions of ms cannot share a y. They share one x, a point per run, oldest left.
 */
function ShapeTrends({ data }: { data: CommandResponse }) {
  const shape = data.shape;

  if (shape.length < 2) {
    return (
      <div className='card empty'>
        A trend needs at least two runs with a recorded start; this selection has {shape.length}. The runs are still
        listed below.
      </div>
    );
  }

  const rows = shape.map((s) => ({
    at: s.started ? fmtLocalTsShort(s.started) : '—',
    nodes: s.nodes,
    toolCalls: s.toolCalls,
    stepsReached: s.stepsReached,
    endToEndMs: s.endToEndMs,
  }));

  // The newest run's snapshot, which is the catalogue the recent points are out of.
  const declared = shape[shape.length - 1]!.stepsDeclared;
  const fellBack = shape.length - data.meta.wallMeasuredRuns;

  return (
    <>
      <div className='card'>
        <div className='card-head'>
          <h2>Steps per run</h2>
          <span className='muted'>oldest first · {declared === 0 ? 'no steps declared' : `${declared} declared`}</span>
        </div>
        <SeriesLineChart
          data={rows}
          series={WORK_SERIES}
          xKey='at'
          format={fmtInt}
          formatTick={fmtCompact}
          height={TREND_HEIGHT}
        />
        <Legend series={WORK_SERIES} />
        <div className='muted' style={{ marginTop: 8 }}>
          <strong>Agent steps</strong> are transcript nodes — every decision, tool call and outcome the run and its
          subagents produced. <strong>Declared steps reached</strong> counts the{' '}
          <span className='rule-name'>## Step N</span> headings attribution placed something against, out of the{' '}
          {declared} the command file declared when each run happened, so a step added later is never counted against an
          older run.
        </div>
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Time per run</h2>
          <span className='muted'>wall clock, end to end</span>
        </div>
        <SeriesLineChart
          data={rows}
          series={TIME_SERIES}
          xKey='at'
          format={fmtDuration}
          formatTick={fmtDuration}
          height={TREND_HEIGHT}
        />
        <Legend series={TIME_SERIES} />
        <div className='muted' style={{ marginTop: 8 }}>
          A top-level run is measured from its session opening to the last write to its transcript, which is longer than
          the span between its requests — that span stops at the last request rather than at the answer to it. A nested
          run has no session of its own, so it is measured across its requests.
          {fellBack > 0 && (
            <>
              {' '}
              {fellBack} of these {shape.length} runs {fellBack === 1 ? 'was' : 'were'} recorded before the wider
              measurement existed and {fellBack === 1 ? 'is' : 'are'} plotted on the request span alone; there is no
              backfill.
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The swatch strip under a line chart. */
function Legend({ series }: { series: Series[] }) {
  return (
    <div className='chartlegend'>
      {series.map((s) => (
        <span className='chartlegend-item' key={s.dataKey}>
          <span className='chartlegend-swatch' style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/**
 * Where the tokens go, step by step, with the unattributed bucket kept in view rather
 * than folded away. Aggregate by default; hovering a run in the list below swaps it to
 * that run alone.
 */
function StepBar({
  steps,
  reach,
  run,
  totalRuns,
}: {
  steps: CommandStep[];
  reach: StepReach[];
  run: CommandRunListItem | null;
  totalRuns: number;
}) {
  const rows = reach.map((r, i) => ({
    step: r.step,
    title: r.title,
    reached: r.reached,
    ofRuns: r.ofRuns,
    tokens: r.tokens,
    cost: r.cost,
    color: stepColor(r.step, i),
  }));
  const total = rows.reduce((n, r) => n + r.tokens, 0);

  if (steps.length === 0) {
    return (
      <div className='card'>
        <div className='card-head'>
          <h2>Tokens by step</h2>
        </div>
        <div className='leak-note'>
          This command declares no <span className='rule-name'>## Step N</span> headings, so there is nothing to
          attribute against — every turn lands in the unattributed bucket. That is a property of the command file, not a
          gap in the data.
        </div>
      </div>
    );
  }

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Tokens by step</h2>
        <span className='muted'>
          {run ? `run ${run.threadId.slice(0, 8)}` : `aggregate over ${totalRuns} run${totalRuns === 1 ? '' : 's'}`}
        </span>
      </div>

      {total === 0 ? (
        <div className='empty'>No tokens attributed yet.</div>
      ) : (
        <div className='stackbar'>
          {rows
            .filter((r) => r.tokens > 0)
            .map((r) => (
              <div
                key={r.step ?? 'unattributed'}
                className='stackbar-seg'
                style={{ width: `${(r.tokens / total) * 100}%`, background: r.color }}
                title={`${r.step === null ? 'unattributed' : `Step ${r.step}`}: ${fmtInt(r.tokens)} tokens`}
              />
            ))}
        </div>
      )}

      <table className='table'>
        <thead>
          <tr>
            <th>
              Step
              <HeaderHint text='A ## Step N heading from the command file, as the file stood when the run happened. Turns nothing could be placed against fall in the unattributed row.' />
            </th>
            <th className='num'>
              Runs that got here
              <HeaderHint text='Runs whose attribution reached this step, out of the runs that declared it. A step declared after a run happened is not counted against that run.' />
            </th>
            <th className='num'>
              Tokens
              <HeaderHint text='Tokens on the requests attributed to this step, summed across those runs.' />
            </th>
            <th className='num'>
              Cost
              <HeaderHint text="Dollar cost of the same requests, priced per model at the day's rates." />
            </th>
            <th className='num'>
              Share
              <HeaderHint text="This step's tokens over every token attributed here — including the unattributed row, so the column sums to 100%." />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.step ?? 'unattributed'} className={r.step === null ? 'muted-row' : undefined}>
              <td>
                <span className='charttip-dot' style={{ background: r.color }} />{' '}
                {r.step === null ? <em>unattributed</em> : `${r.step} — ${r.title}`}
              </td>
              <td className='num'>
                {r.ofRuns === 0 ? '—' : `${r.reached} / ${r.ofRuns}`}
                {r.ofRuns > 0 && r.reached === 0 && r.step !== null && <div className='muted'>never reached</div>}
              </td>
              <td className='num'>{fmtInt(r.tokens)}</td>
              <td className='num'>{fmtUsd(r.cost)}</td>
              <td className='num'>{total === 0 ? '—' : fmtPct((r.tokens / total) * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PatternTable({ data }: { data: CommandResponse }) {
  const fired = data.patterns.filter((p) => p.runs > 0);
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Patterns</h2>
        <span className='muted'>deterministic rules, counted across runs</span>
      </div>
      {fired.length === 0 ? (
        <div className='empty'>No rule in the catalogue has fired for this command yet.</div>
      ) : (
        <table className='table'>
          <thead>
            <tr>
              <th>
                Pattern
                <HeaderHint text='A deterministic rule from the catalogue — matched mechanically against the run, not judged by a model.' />
              </th>
              <th className='num'>
                Runs
                <HeaderHint text='Runs the rule fired in at least once, out of the runs counted here.' />
              </th>
              <th className='num'>
                Firings
                <HeaderHint text='Every time the rule fired, summed across those runs — so one run can contribute several.' />
              </th>
            </tr>
          </thead>
          <tbody>
            {fired.map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td className='num'>
                  seen in {p.runs} of {p.ofRuns}
                </td>
                <td className='num'>{fmtInt(p.hits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunList({
  runs,
  command,
  onHover,
}: {
  runs: CommandRunListItem[];
  command: string;
  onHover: (run: CommandRunListItem | null) => void;
}) {
  const navigate = useNavigate();
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Runs</h2>
        <span className='muted'>newest first · hover a row to break its tokens out above</span>
      </div>
      <table className='table'>
        <thead>
          <tr>
            <th>
              Started
              <HeaderHint text="When the run's first captured request was sent, in local time." />
            </th>
            <th>
              Prompt
              <HeaderHint text='The text passed to the command. A nested run has no prompt of its own, so it is named by the command that spawned it.' />
            </th>
            <th>
              Flags
              <HeaderHint text='Flags the run was invoked with. The store keeps the bare name, so -d and --d face together.' />
            </th>
            <th>
              Outcome
              <HeaderHint text='How the run ended, with the interruption beside it when one was recorded.' />
            </th>
            <th className='num'>
              Reached
              <HeaderHint text='The last declared step the run was attributed to — how far down the command file it got.' />
            </th>
            <th className='num'>
              Turns
              <HeaderHint text="Captured requests in the run, its subagents' included. Not chat messages." />
            </th>
            <th className='num'>
              Tokens
              <HeaderHint text='Real input plus output. Cache reads are excluded here, so this is what the run actually added.' />
            </th>
            <th className='num'>
              Cost
              <HeaderHint text="The run's whole dollar cost, cache reads included — priced per model." />
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.runId}
              className='clickable'
              onMouseEnter={() => onHover(r)}
              onMouseLeave={() => onHover(null)}
              onClick={() => navigate({ to: '/commands/$command/$runId', params: { command, runId: r.runId } })}>
              <td className='num muted'>{r.started ? fmtLocalTsShort(r.started) : '—'}</td>
              {/* A nested run has no prompt of its own, so it is named by its parent. */}
              <td className='runprompt'>
                {r.prompt || (
                  <span className='muted'>
                    {r.parentCommand ? `nested in /${r.parentCommand}` : 'no prompt recorded'}
                  </span>
                )}
              </td>
              <td>{r.flags.length === 0 ? <span className='muted'>—</span> : r.flags.map(fmtFlag).join(' ')}</td>
              <td className='nowrap'>
                <span className='charttip-dot' style={{ background: OUTCOME_COLOR[r.outcome] }} /> {r.outcome}
                {r.interruption && <span className='muted'> · {r.interruption}</span>}
              </td>
              <td className='num'>{r.lastStep === null ? <span className='muted'>—</span> : r.lastStep}</td>
              <td className='num'>{fmtInt(r.totals.turns)}</td>
              <td className='num'>{fmtInt(r.totals.tokens.realInput + r.totals.tokens.output)}</td>
              <td className='num'>{fmtUsd(r.totals.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A flag as it was typed. The store keeps the bare name so `-d` and `--d` face together.
 */
export function fmtFlag(flag: string): string {
  return flag.length === 1 ? `-${flag}` : `--${flag}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/commands/$command',
  component: CommandDetailPage,
  staticData: { title: 'Command' },
});
