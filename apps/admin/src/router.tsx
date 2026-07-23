import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { HealthBadge } from "./components/HealthBadge";
import { AdvicePage } from "./routes/advice";
import { ContextDetailPage } from "./routes/context-detail";
import { ContextMessagePage } from "./routes/context-message";
import { ContextToolPage } from "./routes/context-tool";
import { ContextPage } from "./routes/context";
import { FiltersPage } from "./routes/filters";
import { HooksPluginsPage } from "./routes/hooks-plugins";
import { MemoryDetailPage } from "./routes/memory-detail";
import { OverviewPage } from "./routes/overview";
import { ProjectDetailPage } from "./routes/project-detail";
import { ProjectsPage } from "./routes/projects";
import { SessionDetailPage } from "./routes/session-detail";
import { SessionErrorsPage } from "./routes/session-errors";
import { SessionsPage } from "./routes/sessions";
import { SkimPage } from "./routes/skim";
import { ToolsPage } from "./routes/tools";
import { TrendsPage } from "./routes/trends";
import { WithheldPage } from "./routes/withheld";

/** Side-rail nav stations. */
const STATIONS = [
  { to: "/", label: "Overview", hint: "today", exact: true },
  { to: "/trends", label: "Trends", hint: "history", exact: false },
  { to: "/context", label: "Context size", hint: "prompt", exact: false },
  { to: "/tools", label: "Tool bloat", hint: "context", exact: false },
  { to: "/skim", label: "Skim", hint: "cache", exact: false },
  { to: "/withheld", label: "Not added", hint: "withheld", exact: false },
  { to: "/filters", label: "Proxy filters", hint: "stripped", exact: false },
  { to: "/projects", label: "Projects", hint: "memory", exact: false },
  { to: "/sessions", label: "Sessions", hint: "transcripts", exact: false },
  { to: "/hooks-plugins", label: "Hooks & Plugins", hint: "config", exact: false },
  { to: "/advice", label: "Advice", hint: "coaching", exact: false },
] as const;

function RootLayout() {
  const activeProps = { className: "station active" };
  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-head">
          <span className="brand-node" aria-hidden />
          <span className="brand">
            claude<span className="brand-sep">·</span>proxy
          </span>
          <span className="brand-tag">admin</span>
        </div>

        <nav className="stations" aria-label="Sections">
          {STATIONS.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              className="station"
              activeProps={activeProps}
              activeOptions={s.exact ? { exact: true } : undefined}
            >
              <span className="station-node" aria-hidden />
              <span className="station-label">{s.label}</span>
              <span className="station-hint">{s.hint}</span>
            </Link>
          ))}
        </nav>

        <div className="rail-foot">
          <HealthBadge />
        </div>
      </aside>

      <div className="workspace">
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const trendsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/trends", component: TrendsPage });
const contextRoute = createRoute({ getParentRoute: () => rootRoute, path: "/context", component: ContextPage });
const contextDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context/$file",
  component: ContextDetailPage,
});
const contextMessageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context/$file/message/$index",
  component: ContextMessagePage,
});
const contextToolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context/$file/tool/$index",
  component: ContextToolPage,
});
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects", component: ProjectsPage });
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$project",
  component: ProjectDetailPage,
});
const memoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$project/memory/$name",
  component: MemoryDetailPage,
});
const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sessions", component: SessionsPage });
const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: SessionDetailPage,
});
const sessionErrorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id/errors",
  component: SessionErrorsPage,
});
const toolsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: ToolsPage });
const skimRoute = createRoute({ getParentRoute: () => rootRoute, path: "/skim", component: SkimPage });
const withheldRoute = createRoute({ getParentRoute: () => rootRoute, path: "/withheld", component: WithheldPage });
const filtersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/filters", component: FiltersPage });
const hooksPluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hooks-plugins",
  component: HooksPluginsPage,
});
const adviceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/advice", component: AdvicePage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  trendsRoute,
  contextRoute,
  contextDetailRoute,
  contextMessageRoute,
  contextToolRoute,
  projectsRoute,
  projectDetailRoute,
  memoryDetailRoute,
  sessionsRoute,
  sessionDetailRoute,
  sessionErrorsRoute,
  toolsRoute,
  skimRoute,
  withheldRoute,
  filtersRoute,
  hooksPluginsRoute,
  adviceRoute,
]);

export const router = createRouter({ routeTree });
