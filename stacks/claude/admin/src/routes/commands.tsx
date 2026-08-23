import type { AgentTypeUsage, CommandSummary } from '@agent-proxy/claude-core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import { TerminalSquare } from 'lucide-react';
import { getCommands } from '../api';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { Sparkline } from '../components/Sparkline';
import { StatCard } from '../components/StatCard';
import { fmtInt, fmtLocalTsShort, fmtPct, fmtUsd } from '../format';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import type { NavEntry } from './nav';

/**
 * "Commands" — what each installed slash command costs to run.
 *
 * The rows come from `~/.claude/commands/*.md` unioned with every command the run store
 * has history for, so a command a `/sync` removed keeps its past rather than taking it
 * off the page.
 *
 * Everything here is read from `logs/commands/runs.jsonl`, never from the logs directly:
 * transcripts and captured request bodies live for about a day, so a run is distilled
 * into that store while its raw material is still on disk and read back from there
 * afterwards. Data only accrues going forward — a machine that has just picked this up
 * shows installed commands with no runs, which is the honest state, not an error.
 */
export function CommandsPage() {
  const query = useQuery({ queryKey: ['commands'], queryFn: getCommands });
  const live = useLiveQuery<Awaited<ReturnType<typeof getCommands>>>('/api/commands/stream', ['commands']);
  const data = query.data;
  const commands = data?.commands ?? [];
  const withRuns = commands.filter((c) => c.runs > 0);

  return (
    <section>
      <div className='pagehead'>
        <h1>Commands</h1>
        <div className='muted'>
          What each command in <span className='rule-name'>{data?.meta.commandsDir ?? '~/.claude/commands'}</span> costs
          to run — tokens per declared step, and where runs stop.
        </div>
      </div>

      <div className='card' style={{ marginBottom: 16 }}>
        <div className='leak-note'>
          <strong>Capture is passive.</strong> Every real invocation carrying a{' '}
          <span className='rule-name'>&lt;command-name&gt;</span> envelope is a run — there is nothing to tag and no
          harness to start. A run is the top-level session rolled up with its whole subagent tree, and a nested command
          counts both as a segment of its parent and toward its own command's numbers.
        </div>
        <div className='leak-note'>
          <strong>Step attribution is a heuristic.</strong> Steps are the <span className='rule-name'>## Step N</span>{' '}
          headings in the installed file; turns are placed against them by the agent's own narration and by the
          artifacts each step prescribes. It is fallible by design, so every view carries the confidence behind a
          placement and shows an <strong>unattributed</strong> bucket rather than hiding it.
        </div>
      </div>

      <div className='card-head' style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        <LiveIndicator status={live} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<CommandsSkeleton />}>
        {!data ? null : (
          <>
            <div className='grid stats'>
              <StatCard label='Commands' value={fmtInt(data.meta.installed)} sub='installed on this device' />
              <StatCard label='With runs' value={fmtInt(withRuns.length)} sub='something captured' />
              <StatCard label='Runs' value={fmtInt(data.meta.runs)} sub='in the store' />
              <StatCard
                label='Spent'
                value={fmtUsd(commands.reduce((n, c) => n + c.totalCost, 0))}
                sub='across every stored run'
              />
            </div>

            {commands.length === 0 ? (
              <div className='card empty'>
                No commands installed in <span className='rule-name'>{data.meta.commandsDir}</span>, and nothing
                captured yet in <span className='rule-name'>{data.meta.storePath}</span>.
              </div>
            ) : (
              <CommandsTable commands={commands} storePath={data.meta.storePath} />
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** What a spawn whose call named no type reads as on the page. */
const UNNAMED_AGENT = 'unnamed';

/**
 * The agent types a command delegates to, most-used first, as `type ×N`.
 *
 * Only the two busiest are named and the rest are counted; the full list is the cell's
 * `title`.
 */
function agentTypesLabel(types: readonly AgentTypeUsage[] = []): string {
  const top = types.slice(0, 2).map((t) => `${t.agentType ?? UNNAMED_AGENT} ×${t.spawns}`);
  const rest = types.length - top.length;
  return rest > 0 ? `${top.join(' · ')} +${rest}` : top.join(' · ');
}

/** Every type and what it spent, for the cell's tooltip. */
function agentTypesTitle(types: readonly AgentTypeUsage[] = []): string {
  return types.map((t) => `${t.agentType ?? UNNAMED_AGENT}: ${t.spawns} spawns, ${fmtUsd(t.cost)}`).join('\n');
}

/** The columns `CommandsTable` draws. */
const COMMAND_COLUMNS: SkeletonColumn[] = [
  { cell: '42%' },
  { className: 'num', cell: '34%' },
  { className: 'num', cell: '34%' },
  { cell: '58%' },
  { className: 'num', cell: '44%' },
  { className: 'num', cell: '52%' },
  { className: 'num', cell: '44%' },
  { cell: '62%' },
  { className: 'num', cell: '56%' },
];

function CommandsSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='20%' h='0.95em' />
          <Skeleton w='34%' />
        </div>
        <SkeletonTable columns={COMMAND_COLUMNS} rows={8} />
      </div>
    </>
  );
}

function CommandsTable({ commands, storePath }: { commands: CommandSummary[]; storePath: string }) {
  const navigate = useNavigate();
  const anyRuns = commands.some((c) => c.runs > 0);

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>
          {commands.length} command{commands.length === 1 ? '' : 's'}
        </h2>
        <span className='muted'>most-invoked first · click a row for its runs</span>
      </div>

      {!anyRuns && (
        <div className='leak-note'>
          Nothing captured yet. The store at <span className='rule-name'>{storePath}</span> fills as commands are
          actually run through the proxy — this page has no backfill, because the transcripts a past run would need have
          already aged out.
        </div>
      )}

      <div className='table-scroll'>
        <table className='table'>
          <thead>
            <tr>
              <th>Command</th>
              <th className='num'>Steps</th>
              <th className='num'>Runs</th>
              <th>Delegates to</th>
              <th className='num'>Reached the end</th>
              <th className='num'>Tokens</th>
              <th className='num'>Cost</th>
              <th>Cost per run</th>
              <th className='num'>Last run</th>
            </tr>
          </thead>
          <tbody>
            {commands.map((c) => (
              <tr
                key={c.command}
                className='clickable'
                onClick={() => navigate({ to: '/commands/$command', params: { command: c.command } })}>
                <td>
                  <Link
                    to='/commands/$command'
                    params={{ command: c.command }}
                    className='link job-title'
                    onClick={(e) => e.stopPropagation()}>
                    /{c.command}
                  </Link>
                  {!c.installed && (
                    <div className='muted'>
                      <span className='badge was-present'>uninstalled</span> history kept
                    </div>
                  )}
                </td>
                <td className='num'>
                  {c.steps.length === 0 ? <span className='muted'>none declared</span> : c.steps.length}
                </td>
                <td className='num'>{fmtInt(c.runs)}</td>
                <td>
                  {(c.agentTypes ?? []).length === 0 ? (
                    <span className='muted'>—</span>
                  ) : (
                    <span className='rule-name' title={agentTypesTitle(c.agentTypes)}>
                      {agentTypesLabel(c.agentTypes)}
                    </span>
                  )}
                </td>
                <td className='num'>
                  {c.runs === 0 ? <span className='muted'>—</span> : fmtPct(c.completionRate * 100)}
                </td>
                <td className='num'>{c.runs === 0 ? <span className='muted'>—</span> : fmtInt(c.totalTokens)}</td>
                <td className='num'>{c.runs === 0 ? <span className='muted'>—</span> : fmtUsd(c.totalCost)}</td>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the cell is not clickable — this only keeps a click off the row's own handler */}
                <td onClick={(e) => e.stopPropagation()}>
                  {c.costSeries.length > 1 ? (
                    <Sparkline
                      points={c.costSeries.map((p) => ({ date: p.date.slice(0, 10), value: p.value }))}
                      color='var(--accent)'
                      height={28}
                    />
                  ) : (
                    <span className='muted'>needs two runs</span>
                  )}
                </td>
                <td className='num muted'>{c.lastRun ? fmtLocalTsShort(c.lastRun) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/commands',
  component: CommandsPage,
  staticData: { title: 'Commands' },
});

export const nav = {
  section: 'Device',
  to: '/commands',
  label: 'Commands',
  hint: 'per step',
  exact: false,
  icon: TerminalSquare,
} as const satisfies NavEntry;
