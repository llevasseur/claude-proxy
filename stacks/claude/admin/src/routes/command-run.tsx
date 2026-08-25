import type { CommandRun, CommandRunStepStats, CommandRunTurn } from '@agent-proxy/claude-core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { type CommandRunResponse, getCommandRun, getContextMessage } from '../api';
import { CodeBlock } from '../components/CodeBlock';
import { HeaderHint } from '../components/HeaderHint';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import {
  SkeletonCard,
  type SkeletonColumn,
  SkeletonStats,
  SkeletonTableCard,
  SkeletonText,
  SkeletonTextCard,
} from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtBytes, fmtDuration, fmtInt, fmtLocalTs, fmtPct, fmtUsd } from '../format';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import { fmtFlag } from './command-detail';

/** Step colours, cycled — the same palette the command page's stacked bar uses. */
const STEP_COLORS = ['var(--signal)', 'var(--good)', 'var(--amber)', 'var(--violet)', 'var(--coral)'];

function stepColor(step: string | null, index: number): string {
  return step === null ? 'var(--faint)' : STEP_COLORS[index % STEP_COLORS.length]!;
}

/**
 * One run, as a token-weighted tree down its declared steps.
 *
 * The spine is the step catalogue as it stood *when this run happened* — the snapshot in
 * the record, not the file as it reads now — so a `/sync` since then does not silently
 * relabel history. Every captured request hangs off the step it was attributed to, sized
 * by what it cost; the ones nothing could place hang in a gutter of their own rather than
 * being quietly folded into a neighbouring step.
 *
 * Attribution is a heuristic and the page says so: each step carries the confidence
 * behind its placement, and `inferred` means the step was carried forward rather than
 * anchored on anything the run actually did.
 */
export function CommandRunPage() {
  const { command, runId } = useParams({ from: '/commands/$command/$runId' });
  const key = ['command-run', runId];
  const query = useQuery({ queryKey: key, queryFn: () => getCommandRun(runId) });
  // A finished run cannot change, so it holds no stream open. Only a run still in flight
  // subscribes — that is the case the tree is meant to grow through.
  const running = query.data?.run.outcome === 'running';
  const live = useLiveQuery<CommandRunResponse>(
    `/api/commands/run/stream?id=${encodeURIComponent(runId)}`,
    key,
    running,
  );
  const data = query.data;

  return (
    <section>
      <div className='pagehead'>
        <h1>/{command} run</h1>
        <div className='muted'>
          <Link to='/commands' className='link'>
            Commands
          </Link>{' '}
          ·{' '}
          <Link to='/commands/$command' params={{ command }} className='link'>
            /{command}
          </Link>{' '}
          · <span className='rule-name'>{runId}</span>
          {data?.run.parentRunId && data.run.parentCommand && (
            <>
              {' · nested in '}
              <Link
                to='/commands/$command/$runId'
                params={{ command: data.run.parentCommand, runId: data.run.parentRunId }}
                className='link'>
                /{data.run.parentCommand}
              </Link>
            </>
          )}
        </div>
      </div>

      <div className='card-head' style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        {running ? <LiveIndicator status={live} /> : <span className='muted'>this run has finished</span>}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<RunSkeleton />}>
        {!data ? null : <RunBody data={data} />}
      </QueryState>
    </section>
  );
}

const WASTE_COLUMNS: SkeletonColumn[] = [
  { cell: '56%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '44%' },
];

/**
 * `RunBody`'s spine: stats, the prompt, the attribution note, the step tree, the waste
 * table. The turn inspector and the patterns card are conditional, so neither is reserved.
 */
function RunSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <SkeletonTextCard title='The prompt' lines={5} />
      <SkeletonTextCard title='How much of this is guessed' lines={3} />
      <SkeletonCard title='Step tree'>
        <SkeletonText lines={6} />
      </SkeletonCard>
      <SkeletonTableCard title='Waste and rework' columns={WASTE_COLUMNS} rows={5} />
      <SkeletonCard title='Suggestions for this session'>
        <SkeletonText lines={4} />
      </SkeletonCard>
    </>
  );
}

function RunBody({ data }: { data: CommandRunResponse }) {
  const run = data.run;
  const totals = run.totals;
  const meta = run.meta ?? { turnsUnmapped: 0, nodes: 0, attributed: 0, anchored: 0 };
  const [selected, setSelected] = useState<CommandRunTurn | null>(null);

  const anchoredShare = meta.attributed === 0 ? 0 : meta.anchored / meta.attributed;
  const endToEnd = totals.wallMs > 0 ? totals.wallMs : totals.durationMs;

  return (
    <>
      <div className='grid stats'>
        <StatCard
          label='Outcome'
          value={run.outcome}
          sub={run.reachedEnd ? 'reached the last declared step' : (run.interruption ?? 'stopped short')}
        />
        <StatCard label='Cost' value={fmtUsd(totals.cost)} sub={`${fmtInt(totals.turns)} captured requests`} />
        <StatCard
          label='Tokens'
          value={fmtInt(totals.tokens.realInput + totals.tokens.output)}
          sub={`${fmtInt(totals.tokens.cacheRead)} read from cache`}
        />
        <StatCard
          label='End to end'
          value={endToEnd > 0 ? fmtDuration(endToEnd) : '—'}
          sub={
            totals.wallMs > 0 ? `${fmtDuration(totals.durationMs)} of it sending requests` : 'across its requests only'
          }
        />
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>The prompt</h2>
          <span className='muted'>
            {run.flags.length > 0 ? run.flags.map(fmtFlag).join(' ') : 'no flags'} · {run.model ?? 'model unknown'}
          </span>
        </div>
        {run.prompt ? (
          <CodeBlock source={run.prompt} syntax='plain' wrap />
        ) : (
          <div className='empty'>
            The opening prompt was not captured — its request body had already aged out when this run was distilled.
          </div>
        )}
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>How much of this is guessed</h2>
        </div>
        <div className='leak-note'>
          {meta.attributed} of {meta.nodes} transcript nodes were placed against a step, {meta.anchored} of them (
          {fmtPct(anchoredShare * 100)}) anchored on something the run actually did — a narrated step, or an artifact
          the step's body prescribes. The rest were carried forward from the previous anchor, which over-charges a step
          whose successor announces itself late. {meta.turnsUnmapped} captured request
          {meta.turnsUnmapped === 1 ? '' : 's'} could not be placed at all and {meta.turnsUnmapped === 1 ? 'is' : 'are'}{' '}
          in the gutter below, carrying tokens but no step.
        </div>
        {data.meta.requestsAgedOut && (
          <div className='leak-note'>
            Some of this run's request bodies are no longer on disk, so the per-turn inspector cannot show what was new
            in those turns. Their token totals survive here because they were distilled into the store while the raw
            logs were still around; the bodies themselves are gone.
          </div>
        )}
        {data.meta.transcripts > 0 && data.meta.transcriptsPresent < data.meta.transcripts && (
          <div className='leak-note'>
            {data.meta.transcriptsPresent} of {data.meta.transcripts} transcripts in this run's agent family are still
            on disk. Attribution was computed when they were.
          </div>
        )}
      </div>

      <StepTree run={run} selected={selected} onSelect={setSelected} />

      <TurnInspector turn={selected} agedOut={data.meta.requestsAgedOut} />

      <WasteTable steps={run.stepStats ?? []} />

      <SpawnTable run={run} />

      {data.patterns.filter((p) => p.runs > 0).length > 0 && (
        <div className='card'>
          <div className='card-head'>
            <h2>Patterns across /{run.command}</h2>
            <span className='muted'>how common this run's findings are</span>
          </div>
          <div className='table-scroll'>
            <table className='table'>
              <thead>
                <tr>
                  <th>
                    Pattern
                    <HeaderHint text='A deterministic rule from the catalogue that fired somewhere in this command, matched mechanically rather than judged by a model.' />
                  </th>
                  <th className='num'>
                    Frequency
                    <HeaderHint text="Runs of this command the rule fired in, out of the runs counted — how common this run's findings are." />
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.patterns
                  .filter((p) => p.runs > 0)
                  .map((p) => (
                    <tr key={p.id}>
                      <td>{p.title}</td>
                      <td className='num'>
                        seen in {p.runs} of {p.ofRuns} runs
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className='card'>
        <div className='card-head'>
          <h2>Suggestions for this session</h2>
          <span className='muted'>the existing engine's read, linked rather than rebuilt</span>
        </div>
        {data.suggestions.length === 0 ? (
          <div className='empty'>
            No suggestions for this session. They are computed from the transcripts, which age out — an older run may
            simply have none left to compute from.
          </div>
        ) : (
          <ul className='advice-list'>
            {data.suggestions.map((s) => (
              <li key={s.id}>
                <span className={`badge sev-${s.severity}`}>{s.severity}</span> <strong>{s.title}</strong>
                <div className='muted'>{s.detail}</div>
                <div className='muted'>{s.evidence}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The run as a tree: declared steps top to bottom, each turn hanging off the step it was
 * charged to. A node's weight is its share of the run's tokens, so the expensive stretch
 * is visible before reading a single number.
 */
function StepTree({
  run,
  selected,
  onSelect,
}: {
  run: CommandRun;
  selected: CommandRunTurn | null;
  onSelect: (turn: CommandRunTurn | null) => void;
}) {
  const turns = run.turns ?? [];
  const stats = run.stepStats ?? [];
  const maxTurn = Math.max(1, ...turns.map(turnTokens));
  /** The step the run is in right now — highlighted while it is still going. */
  const current = run.outcome === 'running' ? (turns[turns.length - 1]?.step ?? null) : null;

  if (stats.length === 0) {
    return (
      <div className='card empty'>
        This run has no step breakdown stored. It was written by a different schema version than this page reads; its
        totals above are still accurate.
      </div>
    );
  }

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Step tree</h2>
        <span className='muted'>node width = tokens · click a turn for its context delta</span>
      </div>
      <div className='steptree'>
        {stats.map((stat, i) => {
          const color = stepColor(stat.step, i);
          const mine = turns.filter((t) => t.step === stat.step);
          const isCurrent = current !== null && stat.step === current;
          const isGutter = stat.step === null;
          return (
            <div
              key={stat.step ?? 'unattributed'}
              className={`steptree-step${isGutter ? ' gutter' : ''}${isCurrent ? ' current' : ''}`}
              style={{ borderLeftColor: color }}>
              <div className='steptree-head'>
                <span className='steptree-title'>
                  {isGutter ? <em>Unattributed</em> : `Step ${stat.step} — ${stat.title}`}
                </span>
                <span className='muted'>
                  {isGutter
                    ? 'turns no step could be placed against'
                    : stat.reached
                      ? `${stat.confidence ?? 'inferred'} · ${fmtInt(stat.nodes)} nodes · ${fmtInt(stat.toolCalls)} tool calls`
                      : 'never reached'}
                </span>
                <span className='steptree-cost'>
                  {fmtUsd(stat.cost)} · {fmtInt(stat.tokens.realInput + stat.tokens.output)} tok
                </span>
              </div>
              {mine.length === 0 ? (
                <div className='steptree-empty muted'>
                  {stat.reached ? 'no captured request landed here' : 'no turn reached this step'}
                </div>
              ) : (
                <div className='steptree-turns'>
                  {mine.map((turn) => (
                    <button
                      type='button'
                      key={turn.file}
                      className={`steptree-turn${selected?.file === turn.file ? ' active' : ''}${
                        turn.threadId === run.threadId ? '' : ' delegated'
                      }`}
                      style={{ width: `${Math.max(4, (turnTokens(turn) / maxTurn) * 100)}%`, background: color }}
                      title={`${turn.timestamp} · ${fmtInt(turnTokens(turn))} tokens${
                        turn.threadId === run.threadId ? '' : ` · subagent ${turn.threadId.slice(0, 8)}`
                      }`}
                      onClick={() => onSelect(selected?.file === turn.file ? null : turn)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className='chartlegend'>
        <span className='chartlegend-item'>
          <span className='charttip-dot' style={{ background: 'var(--violet)' }} /> a hatched turn was sent by a
          subagent this run spawned
        </span>
      </div>
    </div>
  );
}

/**
 * What one turn added. The store keeps the per-turn totals, so the sizes are always
 * readable; the actual new message needs the raw request body, which lives about a day.
 * When it is gone this says so rather than rendering an empty panel.
 */
function TurnInspector({ turn, agedOut }: { turn: CommandRunTurn | null; agedOut: boolean }) {
  const enabled = turn !== null && turn.messageCount > 0;
  const index = turn ? turn.messageCount - 1 : 0;
  const message = useQuery({
    queryKey: ['command-turn', turn?.file ?? '', index],
    queryFn: () => getContextMessage(turn?.file ?? '', index),
    enabled,
    retry: false,
  });

  if (!turn) {
    return (
      <div className='card empty'>
        Select a turn in the tree above to see what was new in its context and what that cost.
      </div>
    );
  }

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Turn delta</h2>
        <span className='muted'>{fmtLocalTs(turn.timestamp)}</span>
      </div>
      <div className='grid stats'>
        <StatCard label='Real input' value={fmtInt(turn.tokens.realInput)} sub='prompt tokens that missed the cache' />
        <StatCard label='Cache read' value={fmtInt(turn.tokens.cacheRead)} sub='re-sent and charged at cache rates' />
        <StatCard label='Output' value={fmtInt(turn.tokens.output)} sub='what the model wrote' />
        <StatCard
          label='Prompt shape'
          value={`${fmtBytes(turn.systemBytes)} sys`}
          sub={`${fmtBytes(turn.toolsBytes)} of tools · ${turn.toolCount} tools · ${turn.messageCount} messages`}
        />
      </div>
      {/* An evicted body is an expected end state, not a failure — the tokens above survive it. */}
      {message.isError || (message.isSuccess && (!message.data || message.data.evicted)) ? (
        <div className='leak-note'>
          This turn's request body is no longer on disk, so its newest message cannot be shown. The token figures above
          come from the run store and are unaffected.
        </div>
      ) : agedOut && !message.isSuccess ? (
        <div className='leak-note'>Some of this run's bodies have aged out; this one may be among them.</div>
      ) : message.isLoading ? (
        <div className='muted'>Loading the message…</div>
      ) : message.data && !message.data.evicted ? (
        <>
          <div className='muted' style={{ marginBottom: 8 }}>
            Message {message.data.message.index + 1} of {message.data.message.messageCount} — the newest in this turn ·{' '}
            {message.data.message.role} · {fmtBytes(message.data.message.bytes)} ≈{' '}
            {fmtInt(message.data.message.estTokens)} tokens
          </div>
          <CodeBlock source={message.data.message.content} syntax='json' />
        </>
      ) : null}
    </div>
  );
}

function WasteTable({ steps }: { steps: CommandRunStepStats[] }) {
  const rows = steps.filter((s) => s.waste && Object.values(s.waste).some((n) => n > 0));
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Waste and rework</h2>
        <span className='muted'>mechanical counters, per step</span>
      </div>
      {rows.length === 0 ? (
        <div className='empty'>Nothing counted: no errored calls, no repeated reads, no retries.</div>
      ) : (
        <div className='table-scroll'>
          <table className='table'>
            <thead>
              <tr>
                <th>
                  Step
                  <HeaderHint text='The step the counters below were tallied under. Only steps with something to report appear.' />
                </th>
                <th className='num'>
                  Errored calls
                  <HeaderHint text='Tool calls that came back an error, counted off the transcript.' />
                </th>
                <th className='num'>
                  Duplicate reads
                  <HeaderHint text='Reads of a path already read in this run — every read past the first.' />
                </th>
                <th className='num'>
                  Retries after an error
                  <HeaderHint text='A call reissued with the same signature right after that same call errored.' />
                </th>
                <th className='num'>
                  No-op turns
                  <HeaderHint text='A narration turn that produced no tool call at all before the next one.' />
                </th>
                <th className='num'>
                  Cache-miss tokens
                  <HeaderHint text="Prompt tokens that missed the cache (real input − cache read) over the step's turns." />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.step ?? 'unattributed'}>
                  <td>{s.step === null ? <em>unattributed</em> : `${s.step} — ${s.title}`}</td>
                  <td className='num'>{fmtInt(s.waste.erroredTools)}</td>
                  <td className='num'>{fmtInt(s.waste.duplicateReads)}</td>
                  <td className='num'>{fmtInt(s.waste.retriedAfterError)}</td>
                  <td className='num'>{fmtInt(s.waste.noOpTurns)}</td>
                  <td className='num'>{fmtInt(s.waste.cacheMissTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Every subagent this run spawned, in family order — parents before their own children —
 * with the type the spawning call named and what that subagent's *own* turns cost.
 *
 * Drawn only when there is something to draw: a record written before this field existed
 * carries no spawns and is never backfilled, so it says nothing rather than claiming the
 * run delegated nothing.
 */
function SpawnTable({ run }: { run: CommandRun }) {
  const spawns = run.spawns ?? [];
  if (spawns.length === 0) return null;

  const delegated = spawns.reduce((n, s) => n + s.cost, 0);
  const share = run.totals.cost > 0 ? delegated / run.totals.cost : 0;

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Spawns</h2>
        <span className='muted'>
          {fmtInt(spawns.length)} subagent{spawns.length === 1 ? '' : 's'} · {fmtUsd(delegated)} ({fmtPct(share * 100)})
          of this run
        </span>
      </div>
      <div className='table-scroll'>
        <table className='table'>
          <thead>
            <tr>
              <th>
                Agent type
                <HeaderHint text="What the spawning call named — its subagent_type, else the skill it invoked. A call that named neither reads 'unnamed', which is a fact about the call rather than missing data." />
              </th>
              <th>
                Step
                <HeaderHint text='The step that was current in the parent when it spawned this agent, so a whole delegated branch is charged to the step that chose to delegate.' />
              </th>
              <th className='num'>Turns</th>
              <th className='num'>Tokens</th>
              <th className='num'>Cost</th>
              <th>Transcript</th>
            </tr>
          </thead>
          <tbody>
            {spawns.map((s) => (
              <tr key={s.threadId}>
                <td style={{ paddingLeft: `calc(var(--space-3) * ${s.depth})` }}>
                  <span className='rule-name'>{s.agentType ?? 'unnamed'}</span>
                </td>
                <td>{s.step === null ? <span className='muted'>unplaced</span> : `Step ${s.step}`}</td>
                <td className='num'>{fmtInt(s.turns)}</td>
                <td className='num'>
                  {s.turns === 0 ? (
                    <span className='muted'>aged out</span>
                  ) : (
                    fmtInt(s.tokens.realInput + s.tokens.output)
                  )}
                </td>
                <td className='num'>{s.turns === 0 ? <span className='muted'>—</span> : fmtUsd(s.cost)}</td>
                <td>
                  <Link to='/sessions/$id' params={{ id: s.threadId }} className='link rule-name' title={s.threadId}>
                    {s.threadId.slice(0, 8)}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function turnTokens(turn: CommandRunTurn): number {
  return turn.tokens.realInput + turn.tokens.output + turn.tokens.cacheCreation;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  // The run id, not the thread id: a nested run shares its host's session.
  path: '/commands/$command/$runId',
  component: CommandRunPage,
  staticData: { title: 'Command run' },
});
