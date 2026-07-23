import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { UsageDigest } from "@claude-proxy/core";
import { getSummary, getTrends, type SummaryResponse } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { QueryState } from "../components/QueryState";
import { StatCard } from "../components/StatCard";
import { fmtInt, fmtPct } from "../format";
import { METRICS } from "../metrics";

const WINDOWS = [7, 14, 30];

export function OverviewPage() {
  const [days, setDays] = useState(7);
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => getSummary() });
  // Per-day history feeds every card's mini chart; shares cache with /trends.
  const trends = useQuery({ queryKey: ["trends", days], queryFn: () => getTrends(days) });
  const data = summary.data;

  return (
    <QueryState isLoading={summary.isLoading} error={summary.error}>
      {data && (
        <OverviewBody data={data} digests={trends.data?.digests ?? []} days={days} onDays={setDays} />
      )}
    </QueryState>
  );
}

function OverviewBody({
  data,
  digests,
  days,
  onDays,
}: {
  data: SummaryResponse;
  digests: UsageDigest[];
  days: number;
  onDays: (d: number) => void;
}) {
  const d = data.digest;
  const delta = Object.fromEntries((d.trend ?? []).map((t) => [t.field, t.deltaPct]));

  if (d.requestCount === 0) {
    return (
      <section>
        <PageHead date={d.date} meta={data.meta} days={days} onDays={onDays} />
        <div className="card empty">No Claude activity captured for {d.date}.</div>
      </section>
    );
  }

  return (
    <section>
      <PageHead date={d.date} meta={data.meta} days={days} onDays={onDays} />
      <div className="grid stats">
        {METRICS.map((m) => (
          <StatCard
            key={m.key}
            label={m.label}
            value={m.headline ? m.headline(d) : m.format(m.value(d))}
            sub={m.sub?.(d)}
            deltaPct={m.trendField ? delta[m.trendField] : undefined}
            increaseIsBad={m.increaseIsBad}
            metric={m.key}
            spark={{
              points: digests.map((x) => ({ date: x.date, value: m.value(x) })),
              color: m.color,
              format: m.format,
            }}
          />
        ))}
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

function PageHead({
  date,
  meta,
  days,
  onDays,
}: {
  date: string;
  meta: { files: number; parseErrors: number };
  days: number;
  onDays: (d: number) => void;
}) {
  return (
    <div className="pagehead">
      <div>
        <h1>Overview</h1>
        <div className="muted">
          {date} · {meta.files} request{meta.files === 1 ? "" : "s"}
          {meta.parseErrors > 0 && ` · ${meta.parseErrors} skipped`}
        </div>
      </div>
      <div className="segmented" aria-label="Mini-chart window">
        {WINDOWS.map((w) => (
          <button key={w} className={w === days ? "active" : ""} onClick={() => onDays(w)}>
            {w}d
          </button>
        ))}
      </div>
    </div>
  );
}
