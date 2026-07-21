import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { HealthBadge } from "./components/HealthBadge";
import { AdvicePage } from "./routes/advice";
import { ContextDetailPage } from "./routes/context-detail";
import { ContextMessagePage } from "./routes/context-message";
import { ContextPage } from "./routes/context";
import { OverviewPage } from "./routes/overview";
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
const toolsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: ToolsPage });
const skimRoute = createRoute({ getParentRoute: () => rootRoute, path: "/skim", component: SkimPage });
const withheldRoute = createRoute({ getParentRoute: () => rootRoute, path: "/withheld", component: WithheldPage });
const adviceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/advice", component: AdvicePage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  trendsRoute,
  contextRoute,
  contextDetailRoute,
  contextMessageRoute,
  toolsRoute,
  skimRoute,
  withheldRoute,
  adviceRoute,
]);

export const router = createRouter({ routeTree });
