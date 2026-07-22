import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ContextEntry } from "@claude-proxy/core";
import { getContext } from "../api";
import { QueryState } from "../components/QueryState";
import { StatCard } from "../components/StatCard";
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from "../format";

const WINDOWS = [7, 14, 30];

export function ContextPage() {
  const [days, setDays] = useState(14);
  const query = useQuery({ queryKey: ["context", days], queryFn: () => getContext(days) });
  const summary = query.data?.summary;

  return (
    <section>
      <div className="pagehead">
        <h1>Context size</h1>
        <div className="segmented">
          {WINDOWS.map((w) => (
            <button key={w} className={w === days ? "active" : ""} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!summary || summary.requestCount === 0 ? (
          <div className="card empty">No context captured in the last {days} days.</div>
        ) : (
          <>
            <div className="muted" style={{ marginBottom: "0.75rem" }}>
              Real input tokens (input + cache) — the true prompt size sent to the model · {summary.requestCount}{" "}
              request{summary.requestCount === 1 ? "" : "s"}
            </div>

            <div className="grid stats">
              <StatCard label="Average context" value={fmtInt(summary.avgRealInput)} sub="tokens / request" />
              <StatCard label="Median context" value={fmtInt(summary.medianRealInput)} sub="tokens / request" />
              <StatCard label="Largest context" value={fmtInt(summary.maxRealInput)} sub="tokens" />
              <StatCard label="Requests" value={fmtInt(summary.requestCount)} sub={`last ${days} days`} />
            </div>

            <RequestsTable entries={summary.entries} maxRealInput={summary.maxRealInput} />
          </>
        )}
      </QueryState>
    </section>
  );
}

type SortKey = "when" | "model" | "realInput" | "systemBytes" | "toolsBytes" | "size";
type SortDir = "asc" | "desc";

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  when: "desc",
  model: "asc",
  realInput: "desc",
  systemBytes: "desc",
  toolsBytes: "desc",
  size: "desc",
};

/** Signed comparison for a column, ascending. The Size bar is drawn from
 * realInput, so it sorts on the same underlying value. */
function compare(a: ContextEntry, b: ContextEntry, key: SortKey): number {
  switch (key) {
    case "when":
      return a.timestamp.localeCompare(b.timestamp);
    case "model":
      return a.model.localeCompare(b.model);
    case "systemBytes":
      return a.systemBytes - b.systemBytes;
    case "toolsBytes":
      return a.toolsBytes - b.toolsBytes;
    default:
      return a.realInput - b.realInput;
  }
}

function RequestsTable({ entries, maxRealInput }: { entries: ContextEntry[]; maxRealInput: number }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "when", dir: "desc" });
  const max = Math.max(1, ...entries.map((e) => e.realInput));

  const sorted = useMemo(() => {
    const rows = [...entries];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === "asc" ? diff : -diff;
    });
    return rows;
  }, [entries, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>Requests</h2>
        <span className="muted">click a column to sort · click a row for the breakdown</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <SortHeader label={`When (${LOCAL_TZ_ABBR})`} sortKey="when" sort={sort} onSort={onSort} />
            <SortHeader label="Model" sortKey="model" sort={sort} onSort={onSort} />
            <SortHeader label="Real input" sortKey="realInput" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="System" sortKey="systemBytes" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Tools" sortKey="toolsBytes" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Size" sortKey="size" sort={sort} onSort={onSort} className="bar-col" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr key={e.file}>
              <td>
                <Link to="/context/$file" params={{ file: e.file }} className="link">
                  {fmtLocalTs(e.timestamp)}
                  {e.realInput === maxRealInput && <span className="muted"> · peak</span>}
                </Link>
              </td>
              <td className="muted">{e.model}</td>
              <td className="num">{fmtInt(e.realInput)}</td>
              <td className="num">{fmtBytes(e.systemBytes)}</td>
              <td className="num">{fmtBytes(e.toolsBytes)}</td>
              <td className="bar-col">
                <div className="rowbar" style={{ width: `${(e.realInput / max) * 100}%` }} />
              </td>
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
