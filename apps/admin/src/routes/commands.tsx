import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CommandSummary } from "@claude-proxy/core";
import { getCommands } from "../api";
import { LiveIndicator } from "../components/LiveIndicator";
import { QueryState } from "../components/QueryState";
import { Sparkline } from "../components/Sparkline";
import { StatCard } from "../components/StatCard";
import { useLiveQuery } from "../useLiveQuery";
import { fmtInt, fmtLocalTsShort, fmtPct, fmtUsd } from "../format";

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
  const query = useQuery({ queryKey: ["commands"], queryFn: getCommands });
  const live = useLiveQuery<Awaited<ReturnType<typeof getCommands>>>("/api/commands/stream", ["commands"]);
  const data = query.data;
  const commands = data?.commands ?? [];
  const withRuns = commands.filter((c) => c.runs > 0);

  return (
    <section>
      <div className="pagehead">
        <h1>Commands</h1>
        <div className="muted">
          What each command in <span className="rule-name">{data?.meta.commandsDir ?? "~/.claude/commands"}</span> costs
          to run — tokens per declared step, and where runs stop.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="leak-note">
          <strong>Capture is passive.</strong> Every real invocation carrying a{" "}
          <span className="rule-name">&lt;command-name&gt;</span> envelope is a run — there is nothing to tag and no
          harness to start. A run is the top-level session rolled up with its whole subagent tree, and a nested command
          counts both as a segment of its parent and toward its own command's numbers.
        </div>
        <div className="leak-note">
          <strong>Step attribution is a heuristic.</strong> Steps are the{" "}
          <span className="rule-name">## Step N</span> headings in the installed file; turns are placed against them by
          the agent's own narration and by the artifacts each step prescribes. It is fallible by design, so every view
          carries the confidence behind a placement and shows an <strong>unattributed</strong> bucket rather than
          hiding it.
        </div>
      </div>

      <div className="card-head" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
        <LiveIndicator status={live} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!data ? null : (
          <>
            <div className="grid stats">
              <StatCard label="Commands" value={fmtInt(data.meta.installed)} sub="installed on this device" />
              <StatCard label="With runs" value={fmtInt(withRuns.length)} sub="something captured" />
              <StatCard label="Runs" value={fmtInt(data.meta.runs)} sub="in the store" />
              <StatCard
                label="Spent"
                value={fmtUsd(commands.reduce((n, c) => n + c.totalCost, 0))}
                sub="across every stored run"
              />
            </div>

            {commands.length === 0 ? (
              <div className="card empty">
                No commands installed in <span className="rule-name">{data.meta.commandsDir}</span>, and nothing
                captured yet in <span className="rule-name">{data.meta.storePath}</span>.
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

function CommandsTable({ commands, storePath }: { commands: CommandSummary[]; storePath: string }) {
  const navigate = useNavigate();
  const anyRuns = commands.some((c) => c.runs > 0);

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {commands.length} command{commands.length === 1 ? "" : "s"}
        </h2>
        <span className="muted">most-invoked first · click a row for its runs</span>
      </div>

      {!anyRuns && (
        <div className="leak-note">
          Nothing captured yet. The store at <span className="rule-name">{storePath}</span> fills as commands are
          actually run through the proxy — this page has no backfill, because the transcripts a past run would need
          have already aged out.
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Command</th>
            <th className="num">Steps</th>
            <th className="num">Runs</th>
            <th className="num">Reached the end</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th>Cost per run</th>
            <th className="num">Last run</th>
          </tr>
        </thead>
        <tbody>
          {commands.map((c) => (
            <tr
              key={c.command}
              className="clickable"
              onClick={() => navigate({ to: "/commands/$command", params: { command: c.command } })}
            >
              <td>
                <Link
                  to="/commands/$command"
                  params={{ command: c.command }}
                  className="link job-title"
                  onClick={(e) => e.stopPropagation()}
                >
                  /{c.command}
                </Link>
                {!c.installed && (
                  <div className="muted">
                    <span className="badge was-present">uninstalled</span> history kept
                  </div>
                )}
              </td>
              <td className="num">{c.steps.length === 0 ? <span className="muted">none declared</span> : c.steps.length}</td>
              <td className="num">{fmtInt(c.runs)}</td>
              <td className="num">
                {c.runs === 0 ? <span className="muted">—</span> : fmtPct(c.completionRate * 100)}
              </td>
              <td className="num">{c.runs === 0 ? <span className="muted">—</span> : fmtInt(c.totalTokens)}</td>
              <td className="num">{c.runs === 0 ? <span className="muted">—</span> : fmtUsd(c.totalCost)}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {c.costSeries.length > 1 ? (
                  <Sparkline
                    points={c.costSeries.map((p) => ({ date: p.date.slice(0, 10), value: p.value }))}
                    color="var(--accent)"
                    height={28}
                  />
                ) : (
                  <span className="muted">needs two runs</span>
                )}
              </td>
              <td className="num muted">{c.lastRun ? fmtLocalTsShort(c.lastRun) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
