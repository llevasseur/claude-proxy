import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
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

function MemoriesTable({ project, files }: { project: string; files: MemoryFileSummary[] }) {
  const navigate = useNavigate();

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {files.length} memor{files.length === 1 ? "y" : "ies"}
        </h2>
        <span className="muted">click a row to read it</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>File</th>
            <th className="num">Size</th>
            <th className="num">Modified</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
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
