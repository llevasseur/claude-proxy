import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { MemoryFileSummary } from "../api";
import { getProjectMemories } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtLocalTsShort } from "../format";

export function ProjectDetailPage() {
  const { project } = useParams({ from: "/projects/$project" });
  const query = useQuery({
    queryKey: ["project-memories", project],
    queryFn: () => getProjectMemories(project),
  });
  const files = query.data?.files;

  return (
    <section>
      <div className="pagehead">
        <h1>Project memories</h1>
        <Link to="/projects" className="link">
          ‹ back to projects
        </Link>
      </div>
      <div className="muted mono-break" style={{ marginBottom: "0.75rem" }}>
        {project}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!files || files.length === 0 ? (
          <div className="card empty">This project has no memory files.</div>
        ) : (
          <MemoriesTable project={project} files={files} />
        )}
      </QueryState>
    </section>
  );
}

type SortKey = "name" | "bytes" | "modified";
type SortDir = "asc" | "desc";

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  bytes: "desc",
  modified: "desc",
};

/** Signed comparison for a column, ascending. */
function compare(a: MemoryFileSummary, b: MemoryFileSummary, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "modified":
      return a.modified.localeCompare(b.modified);
    default:
      return a.bytes - b.bytes;
  }
}

function MemoriesTable({ project, files }: { project: string; files: MemoryFileSummary[] }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "bytes", dir: "desc" });

  const sorted = useMemo(() => {
    const rows = [...files];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === "asc" ? diff : -diff;
    });
    return rows;
  }, [files, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {files.length} memor{files.length === 1 ? "y" : "ies"}
        </h2>
        <span className="muted">click a column to sort · click a row to read it</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <SortHeader label="File" sortKey="name" sort={sort} onSort={onSort} />
            <SortHeader label="Size" sortKey="bytes" sort={sort} onSort={onSort} className="num" />
            <SortHeader label="Modified" sortKey="modified" sort={sort} onSort={onSort} className="num" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => (
            <tr
              key={f.name}
              className="clickable"
              onClick={() => navigate({ to: "/projects/$project/memory/$name", params: { project, name: f.name } })}
            >
              <td>
                <Link
                  to="/projects/$project/memory/$name"
                  params={{ project, name: f.name }}
                  className="link"
                  onClick={(e) => e.stopPropagation()}
                >
                  {f.name}
                </Link>
                {f.name === "MEMORY.md" && <span className="muted"> · index</span>}
              </td>
              <td className="num">{fmtBytes(f.bytes)}</td>
              <td className="num muted">{fmtLocalTsShort(f.modified)}</td>
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
