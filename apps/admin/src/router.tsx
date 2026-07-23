import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
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

/** Browser-tab title for a route, appended after the ClaudeProxy brand. */
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    title?: string;
  }
}

const BRAND = "ClaudeProxy";

/** Keep the document title in sync with the deepest active route's `staticData.title`. */
function useDocumentTitle() {
  const title = useRouterState({
    select: (s) => {
      for (let i = s.matches.length - 1; i >= 0; i--) {
        const t = s.matches[i]?.staticData.title;
        if (t) return t;
      }
      return undefined;
    },
  });
  useEffect(() => {
    document.title = title ? `${BRAND} · ${title}` : BRAND;
  }, [title]);
}

function RootLayout() {
  const activeProps = { className: "station active" };
  useDocumentTitle();
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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
  staticData: { title: "Overview" },
});
const trendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trends",
  component: TrendsPage,
  staticData: { title: "Trends" },
});
const contextRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context",
  component: ContextPage,
  staticData: { title: "Context size" },
});
const contextDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context/$file",
  component: ContextDetailPage,
  staticData: { title: "Context size" },
});
const contextMessageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context/$file/message/$index",
  component: ContextMessagePage,
  staticData: { title: "Context message" },
});
const contextToolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context/$file/tool/$index",
  component: ContextToolPage,
  staticData: { title: "Context tool call" },
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
  staticData: { title: "Projects" },
});
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$project",
  component: ProjectDetailPage,
  staticData: { title: "Project" },
});
const memoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$project/memory/$name",
  component: MemoryDetailPage,
  staticData: { title: "Memory" },
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionsPage,
  staticData: { title: "Sessions" },
});
const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: SessionDetailPage,
  staticData: { title: "Session" },
});
const sessionErrorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id/errors",
  component: SessionErrorsPage,
  staticData: { title: "Session errors" },
});
const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  component: ToolsPage,
  staticData: { title: "Tool bloat" },
});
const skimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skim",
  component: SkimPage,
  staticData: { title: "Skim" },
});
const withheldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/withheld",
  component: WithheldPage,
  staticData: { title: "Not added" },
});
const filtersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/filters",
  component: FiltersPage,
  staticData: { title: "Proxy filters" },
});
const hooksPluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hooks-plugins",
  component: HooksPluginsPage,
  staticData: { title: "Hooks & Plugins" },
});
const adviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/advice",
  component: AdvicePage,
  staticData: { title: "Advice" },
});

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
