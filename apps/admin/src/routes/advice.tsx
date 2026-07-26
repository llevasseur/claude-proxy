import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SessionBucket, SuggestionStatus } from "@claude-proxy/core";
import { getSessionSuggestions, getSuggestionStatus, getSummary } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { QueryState } from "../components/QueryState";
import { isResolved, STATUS_LABEL, SUGGESTION_STATUS_KEY } from "../components/SuggestionStatus";
import { fmtInt, fmtLocalTsShort } from "../format";

export function AdvicePage() {
  const query = useQuery({ queryKey: ["summary"], queryFn: () => getSummary() });
  const advice = query.data?.advice ?? [];

  return (
    <section>
      <div className="pagehead">
        <h1>Advice</h1>
        <div className="muted">{query.data?.digest.date} · deterministic coaching from today's digest</div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        <div className="advice-list wide">
          {advice.map((a) => (
            <AdviceCard key={a.id} advice={a} />
          ))}
        </div>
      </QueryState>

      <SessionSuggestions />
    </section>
  );
}

/**
 * Session suggestions, ten transcripts at a time. The whole history is recomputed
 * server-side on every load, so this list backfills itself — a window that gains
 * its tenth session simply appears with the next fetch.
 */
function SessionSuggestions() {
  const query = useQuery({ queryKey: ["session-suggestions"], queryFn: getSessionSuggestions });
  // Every bucket's flags in one lean call. Marking happens on the detail page.
  const statusQuery = useQuery({ queryKey: [SUGGESTION_STATUS_KEY, "all"], queryFn: () => getSuggestionStatus() });
  const buckets = query.data?.buckets ?? [];
  const statusByKey = new Map(
    (statusQuery.data?.rows ?? []).map((row) => [`${row.bucket}:${row.id}`, row.status] as const),
  );
  const counts = statusQuery.data?.meta.counts;
  const resolved = (counts?.done ?? 0) + (counts?.skipped ?? 0);

  return (
    <>
      <div className="card-head">
        <h2>Session suggestions</h2>
        <span className="muted">
          {query.data ? `${fmtInt(query.data.meta.sessions)} sessions in ${query.data.meta.buckets} windows of 10` : ""}
          {resolved > 0 && ` · ${counts?.done ?? 0} done · ${counts?.skipped ?? 0} skipped`}
        </span>
        {statusQuery.error && <span className="error">flags unavailable: {(statusQuery.error as Error).message}</span>}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {buckets.length === 0 ? (
          <div className="card empty">No session transcripts yet.</div>
        ) : (
          <div className="bucket-list">
            {buckets.map((b) => (
              <BucketRow key={b.index} bucket={b} statusByKey={statusByKey} />
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}

const SEV_LABEL = { high: "High", warn: "Warn", info: "Info" } as const;

function BucketRow({
  bucket,
  statusByKey,
}: {
  bucket: SessionBucket;
  statusByKey: Map<string, SuggestionStatus>;
}) {
  const worst = bucket.suggestions[0];
  const statusOf = (id: string): SuggestionStatus => statusByKey.get(`${bucket.index}:${id}`) ?? "pending";
  const open = bucket.suggestions.filter((s) => !isResolved(statusOf(s.id))).length;
  return (
    <Link to="/advice/sessions/$bucket" params={{ bucket: String(bucket.index) }} className="card bucket-row">
      <div className="bucket-row-head">
        <span className="bucket-label">Sessions {bucket.label}</span>
        {worst && <span className={`badge sev-${worst.severity}`}>{SEV_LABEL[worst.severity]}</span>}
        <span className="muted bucket-range">
          {fmtLocalTsShort(bucket.startedFirst ?? "")} → {fmtLocalTsShort(bucket.startedLast ?? "")}
        </span>
      </div>
      <ul className="bucket-suggestions">
        {bucket.suggestions.map((s) => {
          const status = statusOf(s.id);
          return (
            <li key={s.id} className={isResolved(status) ? "is-resolved" : undefined}>
              <span className={`dot sev-${s.severity}`} aria-hidden />
              {s.title}
              {isResolved(status) && <span className="suggestion-flag">{STATUS_LABEL[status].toLowerCase()}</span>}
            </li>
          );
        })}
      </ul>
      <div className="bucket-stats muted">
        {fmtInt(bucket.stats.tasks)} tasks · {fmtInt(bucket.stats.tools)} tool calls · {fmtInt(bucket.stats.errors)}{" "}
        errors · {bucket.stats.toolsPerTask}/task
        {bucket.suggestions.length > 0 && ` · ${open}/${bucket.suggestions.length} open`}
      </div>
    </Link>
  );
}
