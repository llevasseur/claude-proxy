import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ProjectSummary } from "../api";
import { getProjects } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtInt } from "../format";

export function ProjectsPage() {
  const query = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const projects = query.data?.projects;

  return (
    <section>
      <div className="pagehead">
        <h1>Projects</h1>
        <span className="muted">Claude Code projects with saved memories</span>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!projects || projects.length === 0 ? (
          <div className="card empty">No projects with memories found.</div>
        ) : (
          <>
            <div className="muted" style={{ marginBottom: "0.75rem", wordBreak: "break-all" }}>
              {query.data?.meta.projectsDir}
            </div>
            <ProjectsTable projects={projects} />
          </>
        )}
      </QueryState>
    </section>
  );
}

function ProjectsTable({ projects }: { projects: ProjectSummary[] }) {
  const navigate = useNavigate();
  const max = Math.max(1, ...projects.map((p) => p.memoryCount));

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {projects.length} project{projects.length === 1 ? "" : "s"}
        </h2>
        <span className="muted">click a row for its memories</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Project</th>
            <th className="num">Memories</th>
            <th className="bar-col">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr
              key={p.name}
              className="clickable"
              onClick={() => navigate({ to: "/projects/$project", params: { project: p.name } })}
            >
              <td>
                <Link
                  to="/projects/$project"
                  params={{ project: p.name }}
                  className="link mono-break"
                  onClick={(e) => e.stopPropagation()}
                >
                  {p.name}
                </Link>
              </td>
              <td className="num">{fmtInt(p.memoryCount)}</td>
              <td className="bar-col">
                <div className="rowbar" style={{ width: `${(p.memoryCount / max) * 100}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
