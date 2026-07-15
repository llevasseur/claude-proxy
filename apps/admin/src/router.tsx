import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { HealthBadge } from "./components/HealthBadge";
import { AdvicePage } from "./routes/advice";
import { OverviewPage } from "./routes/overview";
import { ToolsPage } from "./routes/tools";
import { TrendsPage } from "./routes/trends";

function RootLayout() {
  const activeProps = { className: "navlink active" };
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          claude-proxy <span>admin</span>
        </div>
        <nav className="nav">
          <Link to="/" className="navlink" activeProps={activeProps} activeOptions={{ exact: true }}>
            Overview
          </Link>
          <Link to="/trends" className="navlink" activeProps={activeProps}>
            Trends
          </Link>
          <Link to="/tools" className="navlink" activeProps={activeProps}>
            Tool bloat
          </Link>
          <Link to="/advice" className="navlink" activeProps={activeProps}>
            Advice
          </Link>
        </nav>
        <HealthBadge />
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const trendsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/trends", component: TrendsPage });
const toolsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: ToolsPage });
const adviceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/advice", component: AdvicePage });

const routeTree = rootRoute.addChildren([indexRoute, trendsRoute, toolsRoute, adviceRoute]);

export const router = createRouter({ routeTree });
