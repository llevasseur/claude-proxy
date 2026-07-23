import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { SessionSummary } from "../api";
import { getSessions } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt, fmtLocalTsShort } from "../format";

export function SessionsPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: getSessions });
  const sessions = query.data?.sessions;

  return (
    <section>
      <div className="pagehead">
        <h1>Sessions</h1>
        <span className="muted">Append-only agent transcripts the proxy captured</span>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!sessions || sessions.length === 0 ? (
          <div className="card empty">No session transcripts yet.</div>
        ) : (
          <>
            <div className="muted mono-break" style={{ marginBottom: "0.75rem" }}>
              {query.data?.meta.sessionsDir}
            </div>
            <SessionsTable sessions={sessions} />
          </>
        )}
      </QueryState>
    </section>
  );
}

type SortKey = "threadId" | "model" | "tasks" | "tools" | "errors" | "modified";
type SortDir = "asc" | "desc";

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  threadId: "asc",
  model: "asc",
  tasks: "desc",
  tools: "desc",
  errors: "desc",
  modified: "desc",
};

/** Signed comparison for a column, ascending. */
function compare(a: SessionSummary, b: SessionSummary, key: SortKey): number {
  switch (key) {
    case "threadId":
      return a.threadId.localeCompare(b.threadId);
    case "model":
      return (a.model ?? "").localeCompare(b.model ?? "");
    case "modified":
      return a.modified.localeCompare(b.modified);
    default:
      return a[key] - b[key];
  }
}

function SessionsTable({ sessions }: { sessions: SessionSummary[] }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "modified", dir: "desc" });

  const sorted = useMemo(() => {
    const rows = [...sessions];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === "asc" ? diff : -diff;
    });
    return rows;
  }, [sessions, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </h2>
        <span className="muted">click a column to sort · click a row to read the transcript</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <SortHeader label="Session" sortKey="threadId" sort={sort} onSort={onSort} />
            <SortHeader label="Model" sortKey="model" sort={sort} onSort={onSort} />
            <SortHeader label="Tasks" sortKey="tasks" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Tools" sortKey="tools" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Errors" sortKey="errors" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Updated" sortKey="modified" sort={sort} onSort={onSort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr
              key={s.threadId}
              className="clickable"
              onClick={() => navigate({ to: "/sessions/$id", params: { id: s.threadId } })}
            >
              <td>
                <Link
                  to="/sessions/$id"
                  params={{ id: s.threadId }}
                  className="link mono-break"
                  onClick={(e) => e.stopPropagation()}
                >
                  {s.threadId}
                </Link>
                {s.firstTask && <div className="muted session-preview">{s.firstTask}</div>}
              </td>
              <td className="mono-break">{s.model ?? "—"}</td>
              <td className="num">{fmtInt(s.tasks)}</td>
              <td className="num">{fmtInt(s.tools)}</td>
              <td className="num">
                {s.errors > 0 ? (
                  <Link
                    to="/sessions/$id/errors"
                    params={{ id: s.threadId }}
                    className="error error-count"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {fmtInt(s.errors)}
                  </Link>
                ) : (
                  <span className="muted">0</span>
                )}
              </td>
              <td className="num muted">{fmtLocalTsShort(s.modified)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={["sortable", className].filter(Boolean).join(" ")}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span className="sort-arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}
