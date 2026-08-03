import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import type { UsageDigest } from "@claude-proxy/core";
import { getSummary, getTrends, getUsage, type SummaryResponse, type UsageResponse } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { LiveIndicator } from "../components/LiveIndicator";
import { QueryState } from "../components/QueryState";
import { DAY_WINDOWS, Segmented } from "../components/Segmented";
import { Skeleton, SkeletonStats, SkeletonText } from "../components/Skeleton";
import { StatCard } from "../components/StatCard";
import { UsageMeter } from "../components/UsageMeter";
import { fmtInt, fmtPct } from "../format";
import { METRICS, REPORT_TZ_ABBR } from "../metrics";
import { useLiveQuery, type LiveStatus } from "../useLiveQuery";
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
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => getUsage() });
  // Both streams watch the log directory, so a request in flight moves the meters
  // and today's digest without a reload; the queries above cover SSE being down.
  const usageLive = useLiveQuery<UsageResponse>("/api/usage/stream", ["usage"]);
  const summaryLive = useLiveQuery<SummaryResponse>("/api/summary/stream", ["summary"]);
  const data = summary.data;

  return (
    <section>
      <PageHead
        data={data}
        loading={summary.isLoading}
        days={days}
        onDays={selectDays}
        // Only the mini charts follow this window; the headline numbers come from
        // today's digest, so the switcher marks itself and the cards stay at full strength.
        busy={isSwitching || trends.isFetching}
        live={worstStatus(usageLive, summaryLive)}
      />

      <UsageSection
        data={usage.data}
        isLoading={usage.isLoading}
        error={usage.error}
      />
      {/* Both queries gate the skeleton: the tiles carry a mini chart drawn from the
          trends window, so landing them separately would grow the row twice. */}
      <QueryState
        isLoading={summary.isLoading || trends.isLoading}
        error={summary.error}
        skeleton={<OverviewSkeleton />}
      >
        {data && <OverviewBody data={data} digests={trends.data?.digests ?? []} />}
      </QueryState>
    </section>
  );
}

/** The less healthy of two stream states — one badge speaks for both. */
function worstStatus(a: LiveStatus, b: LiveStatus): LiveStatus {
  if (a === "offline" || b === "offline") return "offline";
  if (a === "connecting" || b === "connecting") return "connecting";
  return "live";
}

/**
 * The subscription allowances, above the day's statistics. Renders nothing when
 * no window can be measured and nothing went wrong — neither captured headers
 * nor configured ceilings means there is no meter worth showing.
 */
function UsageSection({
  data,
  isLoading,
  error,
}: {
  data?: UsageResponse;
  isLoading: boolean;
  error: Error | null;
}) {
  if (isLoading) {
    return (
      <div className="grid usage" aria-hidden>
        {Array.from({ length: 2 }, (_, i) => (
          <div className="card usage-meter" key={i}>
            <Skeleton w="42%" h="0.8em" />
            <div style={{ margin: "10px 0" }}>
              <Skeleton w="30%" h="1.6em" />
            </div>
            <Skeleton w="100%" h="7px" />
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    );
  }
  // A failed usage read must not take the whole Overview down with it.
  if (error) return <div className="card usage-note">Usage limits unavailable: {error.message}</div>;
  if (!data) return null;

  const { windows, unavailable } = data.usage;
  if (windows.length === 0) {
    return unavailable ? <div className="card usage-note">{unavailable}</div> : null;
  }

  return (
    <div className="grid usage">
      {windows.map((w) => (
        <UsageMeter key={w.kind} meter={w} />
      ))}
    </div>
  );
}

/** The cards and panels this page loads into, at their loaded size. */
function OverviewSkeleton() {
  return (
    <>
      <SkeletonStats count={METRICS.length} spark />
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

/**
 * Today's digest as the summary stream last reported it, spliced into the trends
 * window. `/api/trends` is a one-shot read, so without this the mini charts and
 * their popovers would hold the values today had when the page loaded while the
 * headline number moved on.
 */
function withLiveToday(digests: UsageDigest[], today: UsageDigest): UsageDigest[] {
  const at = digests.findIndex((x) => x.date === today.date);
  if (at === -1) return [...digests, today];
  return digests.map((x, i) => (i === at ? today : x));
}

function OverviewBody({ data, digests }: { data: SummaryResponse; digests: UsageDigest[] }) {
  const d = data.digest;
  const delta = Object.fromEntries((d.trend ?? []).map((t) => [t.field, t.deltaPct]));
  const series = useMemo(() => withLiveToday(digests, d), [digests, d]);

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
              points: series.map((x) => ({ date: x.date, value: m.value(x) })),
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
  loading,
  days,
  onDays,
  busy,
  live,
}: {
  data?: SummaryResponse;
  loading: boolean;
  days: number;
  onDays: (d: number) => void;
  busy?: boolean;
  live: LiveStatus;
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
          ) : loading ? (
            <Skeleton w="14rem" />
          ) : null}
        </div>
      </div>
      <div className="pagehead-controls">
        <LiveIndicator status={live} />
        <Segmented options={DAY_WINDOWS} value={days} onSelect={onDays} label="Mini-chart window" busy={busy} />
      </div>
    </div>
  );
}
