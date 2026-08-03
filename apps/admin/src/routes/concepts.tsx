import { useQuery } from "@tanstack/react-query";
import { getConcepts } from "../api";
import { LiveIndicator } from "../components/LiveIndicator";
import { QueryState } from "../components/QueryState";
import { Skeleton, type SkeletonColumn, SkeletonTable } from "../components/Skeleton";
import { useLiveQuery } from "../useLiveQuery";

/**
 * "Concepts" — every term `/teach` has explained, newest first.
 *
 * The list is the store: `logs/concepts.jsonl` is append-only and nothing retracts a
 * line, so there is no filter and no paging — a term taught twice appears twice, which
 * is itself worth seeing.
 */
export function ConceptsPage() {
  const query = useQuery({ queryKey: ["concepts"], queryFn: getConcepts });
  // Live: `/teach` appends from outside the server, so the page follows the file.
  const live = useLiveQuery("/api/concepts/stream", ["concepts"]);
  const data = query.data;
  const concepts = data?.concepts ?? [];

  return (
    <section>
      <div className="pagehead">
        <h1>Concepts</h1>
        <LiveIndicator status={live} />
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        What <span className="rule-name">/teach</span> has recorded, from{" "}
        <span className="rule-name">{data?.meta.storePath ?? "logs/concepts.jsonl"}</span>.
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ConceptsSkeleton />}>
        {concepts.length === 0 ? (
          <div className="card empty">
            Nothing taught yet. Run <span className="rule-name">/teach &lt;term&gt;</span> in a session and it lands
            here.
          </div>
        ) : (
          <div className="card">
            <div className="muted">
              <strong>{concepts.length}</strong> concept{concepts.length === 1 ? "" : "s"} saved.
            </div>
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Explanation</th>
                  <th>Field</th>
                  <th>Skills</th>
                  <th>Saved</th>
                </tr>
              </thead>
              <tbody>
                {concepts.map((c, i) => (
                  // The store has no key, so position is the only stable identity.
                  <tr key={`${c.savedAt}-${c.term}-${i}`}>
                    <td className="rule-name">{c.term}</td>
                    <td>{c.sentence || <span className="muted">—</span>}</td>
                    <td>{c.field ? <span className="badge neutral">{c.field}</span> : <span className="muted">—</span>}</td>
                    <td>
                      {c.skills.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        c.skills.map((skill) => (
                          <span className="badge sev-info" key={skill} style={{ marginRight: 4 }}>
                            {skill}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="muted">{formatSaved(c.savedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** Local date and time; an unparseable timestamp is shown as recorded. */
function formatSaved(savedAt: string): string {
  const at = new Date(savedAt);
  return Number.isNaN(at.getTime()) ? savedAt : at.toLocaleString();
}

/** The one card on this page, five columns wide. */
const CONCEPT_COLUMNS: readonly SkeletonColumn[] = [{ cell: "60%" }, {}, { cell: "50%" }, { cell: "70%" }, { cell: "44%" }];

function ConceptsSkeleton() {
  return (
    <div className="card">
      <div className="muted" aria-hidden>
        <Skeleton w="32%" />
      </div>
      {/* The real table carries this offset itself. */}
      <div style={{ marginTop: 12 }}>
        <SkeletonTable columns={CONCEPT_COLUMNS} rows={6} />
      </div>
    </div>
  );
}
