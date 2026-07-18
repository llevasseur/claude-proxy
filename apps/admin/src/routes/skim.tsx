import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { SkimDigest } from "@claude-proxy/core";
import { getSkim, getSkimTrend } from "../api";
import { BarChart } from "../components/BarChart";
import { QueryState } from "../components/QueryState";
import { type Series, SeriesLineChart } from "../components/SeriesLineChart";
import { StatCard } from "../components/StatCard";
import { fmtInt, fmtPct, fmtUsd } from "../format";

const WINDOWS = [7, 14, 30];

const HIT_RATE_SERIES: Series[] = [{ dataKey: "hitRate", name: "Hit rate", color: "var(--good)" }];
const SAVED_SERIES: Series[] = [{ dataKey: "cumUsd", name: "Cumulative saved", color: "var(--accent-2)" }];

/** Short, human-glanceable form of a byte-exact request hash. */
const shortKey = (k: string): string => (k.length > 12 ? `${k.slice(0, 12)}…` : k);

/** Per-day hit-rate row (percentage) for the line chart. */
function toHitRateRow(d: SkimDigest) {
  return { label: d.date.slice(5), hitRate: Number((d.hitRate * 100).toFixed(1)) };
}

/** Per-day running-total of estimated dollars saved. */
function toCumulativeRows(digests: SkimDigest[]) {
  let running = 0;
  return digests.map((d) => {
    running += d.estSavedUsd;
    return { label: d.date.slice(5), cumUsd: Number(running.toFixed(4)) };
  });
}

/**
 * "Skim" — study whether the opt-in app-layer response cache (wayfinder ticket
 * 001) is worth keeping. On a byte-exact repeat request the proxy replays the
 * stored reply and makes zero call to Anthropic; every request records a `skim`
 * sidecar block, so hit-rate and dollars saved are measurable here.
 */
export function SkimPage() {
  const [days, setDays] = useState(14);
  const trendQuery = useQuery({ queryKey: ["skim-trend", days], queryFn: () => getSkimTrend(days) });
  const dayQuery = useQuery({ queryKey: ["skim-day"], queryFn: () => getSkim() });

  const digests = trendQuery.data?.digests ?? [];
  const today = dayQuery.data?.skim;
  const hitRateRows = useMemo(() => digests.map(toHitRateRow), [digests]);
  const cumulativeRows = useMemo(() => toCumulativeRows(digests), [digests]);
  const windowTotalUsd = digests.reduce((n, d) => n + d.estSavedUsd, 0);

  return (
    <section>
      <div className="pagehead">
        <h1>Skim</h1>
        <div className="segmented">
          {WINDOWS.map((w) => (
            <button key={w} className={w === days ? "active" : ""} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      <QueryState isLoading={trendQuery.isLoading} error={trendQuery.error}>
        {today && (
          <div className="grid stats">
            <StatCard
              label="Hit rate (today)"
              value={fmtPct(today.hitRate * 100, 1)}
              sub={`${fmtInt(today.hits)} / ${fmtInt(today.enabledRequests)} enabled`}
              increaseIsBad={false}
            />
            <StatCard label="Saved today" value={fmtUsd(today.estSavedUsd)} sub="approx." increaseIsBad={false} />
            <StatCard
              label={`Saved (${days}d)`}
              value={fmtUsd(windowTotalUsd)}
              sub="approx."
              increaseIsBad={false}
            />
            <StatCard
              label="Saved input tokens (today)"
              value={fmtInt(today.savedInputTokens)}
              increaseIsBad={false}
            />
          </div>
        )}

        {digests.length === 0 ? (
          <div className="card empty">No skim activity captured in the last {days} days.</div>
        ) : (
          <>
            <div className="card">
              <h2>Hit-rate over time</h2>
              <SeriesLineChart data={hitRateRows} series={HIT_RATE_SERIES} xKey="label" format={(n) => fmtPct(n, 1)} />
            </div>

            <div className="card">
              <h2>Cumulative $ saved</h2>
              <SeriesLineChart data={cumulativeRows} series={SAVED_SERIES} xKey="label" format={fmtUsd} />
            </div>

            {today && today.topShapes.length > 0 && (
              <>
                <div className="card">
                  <h2>Top repeated request shapes (today)</h2>
                  <BarChart
                    data={today.topShapes.slice(0, 12).map((s) => ({ label: shortKey(s.cacheKey), value: s.requests }))}
                    format={fmtInt}
                    color="var(--accent)"
                  />
                </div>

                <div className="card">
                  <h2>By shape</h2>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Cache key</th>
                        <th className="num">Requests</th>
                        <th className="num">Hits</th>
                        <th className="num">Saved tokens</th>
                        <th className="num">Est. saved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {today.topShapes.map((s) => (
                        <tr key={s.cacheKey}>
                          <td title={s.cacheKey}>{shortKey(s.cacheKey)}</td>
                          <td className="num">{fmtInt(s.requests)}</td>
                          <td className="num">{fmtInt(s.hits)}</td>
                          <td className="num">{fmtInt(s.savedInputTokens)}</td>
                          <td className="num">{fmtUsd(s.estSavedUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}
