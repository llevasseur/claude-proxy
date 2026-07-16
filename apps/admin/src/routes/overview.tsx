import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getSummary, type SummaryResponse } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { QueryState } from "../components/QueryState";
import { StatCard } from "../components/StatCard";
import { fmtInt, fmtPct, fmtUsd } from "../format";

export function OverviewPage() {
  const query = useQuery({ queryKey: ["summary"], queryFn: () => getSummary() });
  const data = query.data;

  return (
    <QueryState isLoading={query.isLoading} error={query.error}>
      {data && <OverviewBody data={data} />}
    </QueryState>
  );
}

function OverviewBody({ data }: { data: SummaryResponse }) {
  const d = data.digest;
  const delta = Object.fromEntries((d.trend ?? []).map((t) => [t.field, t.deltaPct]));

  if (d.requestCount === 0) {
    return (
      <section>
        <PageHead date={d.date} meta={data.meta} />
        <div className="card empty">No Claude activity captured for {d.date}.</div>
      </section>
    );
  }

  return (
    <section>
      <PageHead date={d.date} meta={data.meta} />
      <div className="grid stats">
        <StatCard label="Real input tokens" value={fmtInt(d.tokens.realInput)} deltaPct={delta.realInput} />
        <StatCard label="Output tokens" value={fmtInt(d.tokens.output)} deltaPct={delta.output} />
        <StatCard label="Est. cost" value={fmtUsd(d.cost.total)} sub="approx." deltaPct={delta.cost} />
        <StatCard label="Cache-hit ratio" value={fmtPct(d.tokens.cacheHitRatio * 100)} increaseIsBad={false} />
        <StatCard label="Requests" value={fmtInt(d.requestCount)} deltaPct={delta.requestCount} />
        <StatCard
          label="Busiest hour"
          value={d.busiestHour ? `${String(d.busiestHour.hour).padStart(2, "0")}:00` : "—"}
          sub={d.busiestHour ? `${d.busiestHour.requestCount} req · UTC` : undefined}
        />
        <StatCard label="Tool overhead" value={fmtPct(d.toolOverheadPctOfInput)} sub="of input tokens" />
        <StatCard label="Avg system prompt" value={`${fmtInt(d.avgSystemPromptBytes)} B`} />
      </div>

      <div className="grid two">
        <div className="card">
          <div className="card-head">
            <h2>Top context-eating tools</h2>
            <Link to="/tools" className="link">
              all →
            </Link>
          </div>
          <ul className="minilist">
            {d.topTools.slice(0, 5).map((t) => (
              <li key={t.name}>
                <span>{t.name}</span>
                <span className="muted">
                  {fmtPct(t.pctOfToolBytes, 1)} · ~{fmtInt(t.estTokens)} tok
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Advice</h2>
            <Link to="/advice" className="link">
              all →
            </Link>
          </div>
          <div className="advice-list">
            {data.advice.slice(0, 2).map((a) => (
              <AdviceCard key={a.id} advice={a} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PageHead({ date, meta }: { date: string; meta: { files: number; parseErrors: number } }) {
  return (
    <div className="pagehead">
      <h1>Overview</h1>
      <div className="muted">
        {date} · {meta.files} request{meta.files === 1 ? "" : "s"}
        {meta.parseErrors > 0 && ` · ${meta.parseErrors} skipped`}
      </div>
    </div>
  );
}
