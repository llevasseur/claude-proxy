import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useMemo, useState } from "react";
import { type ConceptRow, getConcepts } from "../api";
import { LiveIndicator } from "../components/LiveIndicator";
import { QueryState } from "../components/QueryState";
import { Skeleton, type SkeletonColumn, SkeletonTable } from "../components/Skeleton";
import { useLiveQuery } from "../useLiveQuery";

/**
 * "Concepts" — every term `/teach` has explained, newest first.
 *
 * The list is the store: `logs/concepts.jsonl` is append-only and nothing retracts a
 * line, so there is no filter and no paging — a term taught twice appears twice, which
 * is itself worth seeing. Each row opens its own page, addressed by `ord` — the line the
 * record sits on, since the term can repeat.
 */

type SortKey = "term" | "field" | "savedAt";
type SortDir = "asc" | "desc";

/** What a column sorts as when you first click it — dates newest first, names A→Z. */
const DEFAULT_DIR: Record<SortKey, SortDir> = { term: "asc", field: "asc", savedAt: "desc" };

export function ConceptsPage() {
  const query = useQuery({ queryKey: ["concepts"], queryFn: getConcepts });
  // Live: `/teach` appends from outside the server, so the page follows the file.
  const live = useLiveQuery("/api/concepts/stream", ["concepts"]);
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "savedAt", dir: "desc" });
  const data = query.data;
  const concepts = data?.concepts ?? [];

  const onSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] }));

  const sorted = useMemo(() => sortRows(concepts, sort.key, sort.dir), [concepts, sort]);

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
              <strong>{concepts.length}</strong> concept{concepts.length === 1 ? "" : "s"} saved · click a column to
              sort · click a row to read the detail
            </div>
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  {/* Term sizes to its longest value; Explanation, the only column with
                      no width, absorbs what is left and wraps. */}
                  <SortHeader label="Term" sortKey="term" sort={sort} onSort={onSort} style={FIT_COLUMN} />
                  <th>Explanation</th>
                  <SortHeader label="Field" sortKey="field" sort={sort} onSort={onSort} style={FIT_COLUMN} />
                  <th>Skills</th>
                  <SortHeader label="Saved" sortKey="savedAt" sort={sort} onSort={onSort} style={FIT_COLUMN} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr
                    key={c.ord}
                    className="clickable"
                    onClick={() => navigate({ to: "/concepts/$ord", params: { ord: String(c.ord) } })}
                  >
                    <td className="rule-name" style={FIT_COLUMN}>
                      {c.term}
                    </td>
                    <td>{c.sentence || <span className="muted">—</span>}</td>
                    <td style={FIT_COLUMN}>
                      {c.field ? <span className="badge neutral">{c.field}</span> : <span className="muted">—</span>}
                    </td>
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
                    <td className="muted" style={FIT_COLUMN}>
                      {formatSaved(c.savedAt)}
                    </td>
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

/** Shrink-to-fit: the browser gives `1%` columns only what their content needs. */
const FIT_COLUMN = { width: "1%", whiteSpace: "nowrap" } as const;

/** A sortable column head — click to sort, click again to reverse. */
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  style,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  style?: CSSProperties;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className="sortable"
      style={style}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span className="sort-arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

/**
 * A sorted copy. Ties fall back to `ord` descending, so equal fields — an empty
 * one, most often — keep a stable order between renders.
 */
function sortRows(concepts: ConceptRow[], key: SortKey, dir: SortDir): ConceptRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...concepts].sort((a, b) => {
    const cmp =
      key === "savedAt"
        ? a.savedAt.localeCompare(b.savedAt)
        : a[key].localeCompare(b[key], undefined, { sensitivity: "base" });
    return cmp !== 0 ? cmp * sign : b.ord - a.ord;
  });
}

/** Local date and time; an unparseable timestamp is shown as recorded. */
function formatSaved(savedAt: string): string {
  const at = new Date(savedAt);
  return Number.isNaN(at.getTime()) ? savedAt : at.toLocaleString();
}

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
