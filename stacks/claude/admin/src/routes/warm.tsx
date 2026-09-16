import { sessionDisplayName } from '@agent-proxy/claude-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Flame } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getSessions, getWarm, releaseWarm, type SessionSummary, type WarmEntry, type WarmResponse } from '../api';
import { QueryState } from '../components/QueryState';
import { fmtAgeShort, fmtDuration, fmtInt, fmtLocalTsShort } from '../format';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * The sessions the proxy is holding warm, and the control that stops one.
 *
 * The page ADR 0079 deferred. The keepalive registry lives in the proxy's memory, so this
 * reads through `/api/warm` to that process's own `/__warm` rather than off the corpus —
 * which is why an unreachable proxy is drawn as unreachable rather than as nothing warm.
 *
 * **The release travels proxy-side and never wakes the session.** The only other way to stop
 * one is to open it and spend a turn saying so, which spends what the feature saved.
 */

/** A registry this small changes only when a ping fires or a deadline passes. */
const REFETCH_MS = 10_000;

/** Re-render cadence for the relative deadlines, well inside their displayed minute. */
const NOW_TICK_MS = 15_000;

/** The badge each state wears, borrowed from liveness — the same three claims. */
function stateBadge(state: string): string {
  if (state === 'armed') return 'liveness-running';
  if (state === 'pending') return 'liveness-quiet';
  if (state === 'stopped') return 'liveness-unknown';
  return 'neutral';
}

/**
 * The badge a ping's verdict wears. `paid-full-price` takes the severe one: it means the
 * registration is spending tokens and holding nothing open.
 */
function verdictBadge(verdict: string | null): string {
  if (verdict === 'cache-hit') return 'present';
  if (verdict === 'paid-full-price') return 'sev-high';
  if (verdict === 'refused') return 'sev-warn';
  return 'neutral';
}

/**
 * The window the registration asked for, in hours — derived, since the document carries the
 * two instants rather than the figure. A row missing either end shows nothing, not a zero.
 */
function windowHours(entry: WarmEntry): string {
  const from = Date.parse(entry.registeredAt);
  const to = Date.parse(entry.deadline);
  if (Number.isNaN(from) || Number.isNaN(to)) return '—';
  const hours = (to - from) / 3_600_000;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

/** How long the entry has left, or that it is already past. */
function remaining(deadline: string, now: number): string {
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return '—';
  return at <= now ? 'elapsed' : fmtDuration(at - now);
}

/**
 * Start order, with a transcript missing its `- started:` header sorted last rather than
 * first — undated, it must not outrank a dated sibling.
 */
function startKey(session: SessionSummary): string {
  return session.started ?? '￿';
}

/**
 * The transcript each session id resolves to. One id covers a whole family — the root and
 * every subagent spawned under it — so the row takes the earliest start, ties broken by
 * thread id. Core's own root is whichever transcript ends with no parent, which needs the
 * node streams this page does not read, so this is the nearest pick the listing supports.
 */
function transcriptsBySessionId(sessions: SessionSummary[]): Map<string, SessionSummary> {
  const roots = new Map<string, SessionSummary>();
  for (const session of sessions) {
    if (session.sessionId === null) continue;
    const held = roots.get(session.sessionId);
    if (!held) {
      roots.set(session.sessionId, session);
      continue;
    }
    const rank = startKey(session).localeCompare(startKey(held)) || session.threadId.localeCompare(held.threadId);
    if (rank < 0) roots.set(session.sessionId, session);
  }
  return roots;
}

/**
 * The row's session, named by its transcript and linked to it.
 *
 * The registry knows a session by the id the CLI sent, while a transcript is addressed by
 * the thread id the proxy fingerprints, so the link exists only where a transcript still
 * carries that session id. Transcripts hold roughly today, so an older registration keeps
 * the key alone rather than a link landing nowhere.
 */
function SessionName({ entry, transcript }: { entry: WarmEntry; transcript: SessionSummary | undefined }) {
  if (!transcript) {
    return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-4)' }}>{entry.sessionKey}</span>;
  }
  return (
    <>
      <Link to='/sessions/$id' params={{ id: transcript.threadId }} className='link'>
        {sessionDisplayName(transcript)}
      </Link>
      <div className='muted' style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-3)' }}>
        {entry.sessionKey}
      </div>
    </>
  );
}

/**
 * What the last ping read. `Pings` and `Usage units` beside it count what was spent; this
 * is the only column that says what it bought.
 */
function LastPingCell({ entry }: { entry: WarmEntry }) {
  const last = entry.lastPing;
  if (last === null) return <span className='muted'>—</span>;
  return (
    <>
      <span className={`badge ${verdictBadge(entry.lastPingVerdict)}`}>{entry.lastPingVerdict ?? 'unknown'}</span>
      <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
        {fmtInt(last.cacheReadTokens)} cached / {fmtInt(last.inputTokens)} input
        {last.statusCode < 200 || last.statusCode >= 300 ? ` · HTTP ${last.statusCode}` : ''}
      </div>
      <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
        {last.at === '' ? '—' : `${fmtAgeShort(last.at)} ago`}
      </div>
    </>
  );
}

export function WarmPage() {
  const warm = useQuery({ queryKey: ['warm'], queryFn: getWarm, refetchInterval: REFETCH_MS, retry: false });

  // The clock ticks here rather than inside a formatter, so every relative cell on the page
  // moves together and a row is not stale next to its neighbour.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section>
      <div className='pagehead'>
        <div className='pagehead-title'>
          <h1>Warm</h1>
          <div className='muted'>
            Sessions the proxy is holding a prompt cache open for. Releasing one here stops its pings without waking the
            session, so it costs no tokens in the session itself.
          </div>
        </div>
      </div>

      <QueryState isLoading={warm.isLoading} error={warm.error} busy={warm.isFetching}>
        <WarmBody status={warm.data ?? null} now={now} />
      </QueryState>
    </section>
  );
}

function WarmBody({ status, now }: { status: WarmResponse | null; now: number }) {
  if (!status) return null;
  return (
    <>
      <Totals status={status} />
      <Registry status={status} now={now} />
    </>
  );
}

/** What the registry costs, from the proxy's own tallies rather than recounted here. */
function Totals({ status }: { status: WarmResponse }) {
  const totals = status.totals;
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Registry</h2>
        <span className='range'>
          {status.updatedAt === null ? 'never published' : `as of ${fmtLocalTsShort(status.updatedAt)}`}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-9)' }}>
        <Figure label='Registered' value={fmtInt(totals.entries)} />
        <Figure label='Armed' value={fmtInt(totals.armed)} />
        <Figure label='Pending' value={fmtInt(totals.pending)} />
        <Figure label='Resumed' value={fmtInt(totals.resumed)} />
        <Figure label='Pings sent' value={fmtInt(totals.pingsSent)} />
        {/* Usage units, not dollars: the keepalive's cost is justified against the plan's
            own meter rather than a price (ADR 0073). */}
        <Figure label='Usage units' value={totals.usageUnits.toFixed(2)} />
      </div>
      <p className='muted' style={{ marginBottom: 0 }}>
        Read through <code>{status.meta.proxy}/__warm</code>. Pending means the registration has not yet been matched to
        a real request, so nothing is being pinged for it (ADR 0075). Each row's last ping carries its own reading:{' '}
        <strong>cache-hit</strong> read cached tokens and is doing its job, <strong>paid-full-price</strong> was billed
        for the prefix without reading the cache and is worth releasing, and <strong>no-usage-reported</strong> means
        the reply carried no counts to read at all.
      </p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='stat-label'>{label}</div>
      <div className='stat-value'>{value}</div>
    </div>
  );
}

function Registry({ status, now }: { status: WarmResponse; now: number }) {
  if (status.entries.length === 0) {
    return (
      <div className='card'>
        <div className='empty'>
          No session is registered. One appears here after <code>/warm</code> is run in a session, and leaves when it is
          released, resumes, or reaches its deadline.
        </div>
      </div>
    );
  }
  return <RegistryTable entries={status.entries} now={now} />;
}

/** The registered rows, split out so an empty registry runs none of the queries below. */
function RegistryTable({ entries, now }: { entries: WarmEntry[]; now: number }) {
  const queryClient = useQueryClient();
  const release = useMutation({
    mutationFn: (sessionId: string) => releaseWarm(sessionId),
    // No optimism: the refetch is what decides the row is gone, so a release the proxy
    // refused leaves the row exactly where it was rather than blinking it out.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['warm'] }),
  });

  // Same cache key the Sessions page reads them with, so arriving from there costs no second
  // fetch. A failure here costs the row its link, never the registry. The poll runs at the
  // registry's own cadence only while a row is still unmatched.
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: getSessions,
    retry: false,
    refetchInterval: (query) => {
      const roots = transcriptsBySessionId(query.state.data?.sessions ?? []);
      return entries.every((entry) => roots.has(entry.sessionKey)) ? false : REFETCH_MS;
    },
  });
  const transcripts = useMemo(() => transcriptsBySessionId(sessions.data?.sessions ?? []), [sessions.data]);

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Sessions</h2>
        <span className='range'>{entries.length} registered</span>
      </div>
      <div className='table-scroll'>
        <table className='table'>
          <thead>
            <tr>
              <th>Session</th>
              <th>State</th>
              <th className='num'>Window</th>
              <th className='num'>TTL</th>
              <th>Deadline</th>
              <th>Last activity</th>
              <th className='num'>Pings</th>
              <th>Last ping</th>
              <th className='num'>Usage units</th>
              <th>{/* release */}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const pending = release.isPending && release.variables === entry.sessionKey;
              return (
                <tr key={entry.sessionKey}>
                  <td>
                    <SessionName entry={entry} transcript={transcripts.get(entry.sessionKey)} />
                    {entry.outcome !== null && (
                      <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
                        {entry.outcome}
                        {entry.outcomeDetail !== null && ` · ${entry.outcomeDetail}`}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${stateBadge(entry.state)}`}>{entry.state}</span>
                  </td>
                  <td className='num'>{windowHours(entry)}</td>
                  <td className='num'>{entry.ttlMs > 0 ? fmtDuration(entry.ttlMs) : '—'}</td>
                  <td>
                    {remaining(entry.deadline, now)}
                    <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
                      {entry.deadline === '' ? '—' : fmtLocalTsShort(entry.deadline)}
                    </div>
                  </td>
                  <td>{entry.lastActivity === '' ? '—' : `${fmtAgeShort(entry.lastActivity)} ago`}</td>
                  <td className='num'>{fmtInt(entry.pingsSent)}</td>
                  <td>
                    <LastPingCell entry={entry} />
                  </td>
                  <td className='num'>{entry.usageUnits.toFixed(2)}</td>
                  <td>
                    <button
                      type='button'
                      className='btn-quiet'
                      disabled={pending}
                      onClick={() => release.mutate(entry.sessionKey)}>
                      {pending ? 'Releasing…' : 'Release'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {release.error !== null && (
        <p className='error state'>
          Release failed: {release.error instanceof Error ? release.error.message : String(release.error)}
        </p>
      )}
      {release.data?.released === false && (
        <p className='muted state'>
          The proxy was not holding <code>{release.data.sessionId}</code> — it had already stopped.
        </p>
      )}
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/warm',
  component: WarmPage,
  staticData: { title: 'Warm' },
});

export const nav = {
  section: 'Sessions',
  to: '/warm',
  label: 'Warm',
  hint: 'held caches',
  exact: true,
  icon: Flame,
} as const satisfies NavEntry;
