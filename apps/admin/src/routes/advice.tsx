import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SessionBucket } from "@claude-proxy/core";
import { getSessionSuggestions, getSummary } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { QueryState } from "../components/QueryState";
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
  const buckets = query.data?.buckets ?? [];

  return (
    <>
      <div className="card-head">
        <h2>Session suggestions</h2>
        <span className="muted">
          {query.data ? `${fmtInt(query.data.meta.sessions)} sessions in ${query.data.meta.buckets} windows of 10` : ""}
        </span>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {buckets.length === 0 ? (
          <div className="card empty">No session transcripts yet.</div>
        ) : (
          <div className="bucket-list">
            {buckets.map((b) => (
              <BucketRow key={b.index} bucket={b} />
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}

const SEV_LABEL = { high: "High", warn: "Warn", info: "Info" } as const;

function BucketRow({ bucket }: { bucket: SessionBucket }) {
  const worst = bucket.suggestions[0];
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
        {bucket.suggestions.map((s) => (
          <li key={s.id}>
            <span className={`dot sev-${s.severity}`} aria-hidden />
            {s.title}
          </li>
        ))}
      </ul>
      <div className="bucket-stats muted">
        {fmtInt(bucket.stats.tasks)} tasks · {fmtInt(bucket.stats.tools)} tool calls · {fmtInt(bucket.stats.errors)}{" "}
        errors · {bucket.stats.toolsPerTask}/task
      </div>
    </Link>
  );
}
