import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { UsageDigest } from "@claude-proxy/core";
import { getSummary, getTrends, type SummaryResponse } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { QueryState } from "../components/QueryState";
import { DAY_WINDOWS, Segmented } from "../components/Segmented";
import { Skeleton, SkeletonStats, SkeletonText } from "../components/Skeleton";
import { StatCard } from "../components/StatCard";
import { fmtInt, fmtPct } from "../format";
import { METRICS, REPORT_TZ_ABBR } from "../metrics";
import { useTransitionState } from "../useTransitionState";

export function OverviewPage() {
  const [days, selectDays, isSwitching] = useTransitionState(7);
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => getSummary() });
  // Per-day history feeds every card's mini chart; shares cache with /trends.
  const trends = useQuery({
    queryKey: ["trends", days],
    queryFn: () => getTrends(days),
    placeholderData: keepPreviousData,
  });
  const data = summary.data;

  return (
    <section>
      <PageHead
        data={data}
        days={days}
        onDays={selectDays}
        // Only the mini charts follow this window; the headline numbers come from
        // today's digest, so the switcher marks itself and the cards stay at full strength.
        busy={isSwitching || trends.isFetching}
      />
      <QueryState isLoading={summary.isLoading} error={summary.error} skeleton={<OverviewSkeleton />}>
        {data && <OverviewBody data={data} digests={trends.data?.digests ?? []} />}
      </QueryState>
    </section>
  );
}

/** The cards and panels this page loads into, at their loaded size. */
function OverviewSkeleton() {
  return (
    <>
      <SkeletonStats count={METRICS.length} />
      <div className="grid two" aria-hidden>
        <div className="card">
          <div className="card-head">
            <Skeleton w="52%" h="0.95em" />
          </div>
          <ul className="minilist">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i}>
                <Skeleton w="34%" />
                <Skeleton w="28%" />
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="card-head">
            <Skeleton w="30%" h="0.95em" />
          </div>
          <div className="advice-list">
            {Array.from({ length: 2 }, (_, i) => (
              <div className="card" key={i}>
                <Skeleton w="56%" className="skeleton-h2" />
                <SkeletonText lines={2} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function OverviewBody({ data, digests }: { data: SummaryResponse; digests: UsageDigest[] }) {
  const d = data.digest;
  const delta = Object.fromEntries((d.trend ?? []).map((t) => [t.field, t.deltaPct]));

  if (d.requestCount === 0) {
    return <div className="card empty">No Claude activity captured for {d.date}.</div>;
  }

  return (
    <>
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
    </>
  );
}

/**
 * The page head, above the loading boundary: title and window switcher stay usable
 * while the digest loads, and only the day's request-count line waits for data.
 */
function PageHead({
  data,
  days,
  onDays,
  busy,
}: {
  data?: SummaryResponse;
  days: number;
  onDays: (d: number) => void;
  busy?: boolean;
}) {
  return (
    <div className="pagehead">
      <div>
        <h1>Overview</h1>
        <div className="muted">
          {data ? (
            <>
              {data.digest.date} ({REPORT_TZ_ABBR}) · {data.meta.files} request{data.meta.files === 1 ? "" : "s"}
              {data.meta.parseErrors > 0 && ` · ${data.meta.parseErrors} skipped`}
            </>
          ) : (
            <Skeleton w="14rem" />
          )}
        </div>
      </div>
      <Segmented options={DAY_WINDOWS} value={days} onSelect={onDays} label="Mini-chart window" busy={busy} />
    </div>
  );
}
