import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_HISTORY_PAGE_SIZE, HistoryPage } from "./car/historyPage";
import { validateCarSearch, validateHistorySearch } from "./car/searchParams";
import { TrendsPage } from "./car/trendsPage";
import { OverviewPage } from "./OverviewPage";
import { useLiveOverview } from "./overview/useLiveOverview";
import { hashFor, useRoute } from "./router";

const queryClient = new QueryClient();

function Overview() {
  const live = useLiveOverview();
  return <OverviewPage live={live} />;
}

const NAV: ReadonlyArray<{
  readonly name: "overview" | "history" | "trends";
  readonly href: string;
  readonly label: string;
}> = Object.freeze([
  { name: "overview", href: "#/", label: "Overview" },
  { name: "history", href: "#/history", label: "History" },
  { name: "trends", href: "#/trends", label: "Trends" },
]);

export function DashboardShell() {
  const route = useRoute();
  return (
    <>
      <nav className="primary-nav" aria-label="Primary">
        {NAV.map((entry) => (
          <a
            key={entry.name}
            href={entry.href}
            aria-current={route.name === entry.name ? "page" : undefined}
          >
            {entry.label}
          </a>
        ))}
      </nav>
      {route.name === "history" ? (
        <HistoryRouteView search={validateHistorySearch(route.search)} />
      ) : route.name === "trends" ? (
        <TrendsRouteView search={validateCarSearch(route.search)} />
      ) : (
        <Overview />
      )}
    </>
  );
}

function HistoryRouteView({
  search,
}: {
  readonly search: ReturnType<typeof validateHistorySearch>;
}) {
  return (
    <HistoryPage
      filters={search}
      page={search.page ?? 1}
      pageSize={search.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE}
      onSearchChange={(patch) => {
        window.location.hash = hashFor("history", { ...search, ...patch });
      }}
    />
  );
}

function TrendsRouteView({ search }: { readonly search: ReturnType<typeof validateCarSearch> }) {
  return (
    <TrendsPage
      filters={search}
      onSearchChange={(patch) => {
        window.location.hash = hashFor("trends", { ...search, ...patch });
      }}
    />
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DashboardShell />
    </QueryClientProvider>
  );
}
