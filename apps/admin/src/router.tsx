import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import {
  EyeOff,
  FolderGit2,
  Gauge,
  Lightbulb,
  ListFilter,
  MessagesSquare,
  Monitor,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  TrendingUp,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect } from "react";
import { HealthBadge } from "./components/HealthBadge";
import { useRailCollapsed } from "./useRailCollapsed";
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
import { SessionGraphPage } from "./routes/session-graph";
import { SessionsPage } from "./routes/sessions";
import { SkimPage } from "./routes/skim";
import { SuggestionBucketPage } from "./routes/suggestion-bucket";
import { ToolsPage } from "./routes/tools";
import { TrendDetailPage } from "./routes/trend-detail";
import { TrendsPage } from "./routes/trends";
import { WithheldPage } from "./routes/withheld";

/** Side-rail nav stations. */
const STATIONS = [
  { to: "/", label: "Overview", hint: "today", exact: true, icon: Monitor },
  { to: "/trends", label: "Trends", hint: "history", exact: false, icon: TrendingUp },
  { to: "/context", label: "Context size", hint: "prompt", exact: false, icon: Gauge },
  { to: "/tools", label: "Tool bloat", hint: "context", exact: false, icon: Wrench },
  { to: "/skim", label: "Skim", hint: "cache", exact: false, icon: Zap },
  { to: "/withheld", label: "Not added", hint: "withheld", exact: false, icon: EyeOff },
  { to: "/filters", label: "Proxy filters", hint: "stripped", exact: false, icon: ListFilter },
  { to: "/projects", label: "Projects", hint: "memory", exact: false, icon: FolderGit2 },
  { to: "/sessions", label: "Sessions", hint: "transcripts", exact: true, icon: MessagesSquare },
  { to: "/sessions/graph", label: "Live graph", hint: "sessions", exact: false, icon: Network },
  { to: "/hooks-plugins", label: "Hooks & Plugins", hint: "config", exact: false, icon: Puzzle },
  { to: "/advice", label: "Advice", hint: "coaching", exact: false, icon: Lightbulb },
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
  // The live graph fills the whole content area; every other page keeps the padded column.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const full = pathname === "/sessions/graph";
  const [collapsed, toggleRail] = useRailCollapsed();
  const toggleLabel = collapsed ? "Expand navigation" : "Collapse navigation";
  return (
    <div className={`app${collapsed ? " app--rail-collapsed" : ""}`}>
      <aside className="rail">
        <div className="rail-head">
          <span className="brand-node" aria-hidden />
          <span className="brand">
            claude<span className="brand-sep">·</span>proxy
          </span>
          <button
            type="button"
            className="rail-toggle"
            onClick={toggleRail}
            aria-pressed={collapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
          </button>
        </div>

        <nav className="stations" aria-label="Sections">
          {STATIONS.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              className="station"
              activeProps={activeProps}
              activeOptions={s.exact ? { exact: true } : undefined}
              title={collapsed ? s.label : undefined}
            >
              <s.icon className="station-icon" size={17} strokeWidth={1.75} aria-hidden />
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
        <main className={`content${full ? " content--full" : ""}`}>
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
const trendDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trends/$metric",
  component: TrendDetailPage,
  staticData: { title: "Trend" },
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
/** `?session=` hands the graph a session to open on — how the list and a session's page link in. */
export interface SessionGraphSearch {
  session?: string;
}
const sessionGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/graph",
  component: SessionGraphPage,
  staticData: { title: "Live graph" },
  validateSearch: (search: Record<string, unknown>): SessionGraphSearch => {
    const session = search.session;
    return typeof session === "string" && session !== "" ? { session } : {};
  },
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
const suggestionBucketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/advice/sessions/$bucket",
  component: SuggestionBucketPage,
  staticData: { title: "Session suggestions" },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  trendsRoute,
  trendDetailRoute,
  contextRoute,
  contextDetailRoute,
  contextMessageRoute,
  contextToolRoute,
  projectsRoute,
  projectDetailRoute,
  memoryDetailRoute,
  sessionsRoute,
  sessionGraphRoute,
  sessionDetailRoute,
  sessionErrorsRoute,
  toolsRoute,
  skimRoute,
  withheldRoute,
  filtersRoute,
  hooksPluginsRoute,
  adviceRoute,
  suggestionBucketRoute,
]);

export const router = createRouter({ routeTree });
