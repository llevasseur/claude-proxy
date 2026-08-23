import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BoatContextPage,
  BoatMessagesPage,
  BoatPromptMixPage,
  BoatPromptPage,
  BoatPromptsPage,
  BoatSessionsPage,
  BoatToolCallsPage,
  BoatToolsPage,
} from "./boat/boatPages";
import { DEFAULT_HISTORY_PAGE_SIZE, HistoryPage } from "./car/historyPage";
import { validateCarSearch, validateHistorySearch } from "./car/searchParams";
import { TrendsPage } from "./car/trendsPage";
import { OverviewPage } from "./OverviewPage";
import { useLiveOverview } from "./overview/useLiveOverview";
import { hashFor, type RouteName, useRoute } from "./router";

const queryClient = new QueryClient();

function Overview() {
  const live = useLiveOverview();
  return <OverviewPage live={live} />;
}

const NAV: ReadonlyArray<{
  readonly name: RouteName;
  readonly href: string;
  readonly label: string;
}> = Object.freeze([
  { name: "overview", href: "#/", label: "Overview" },
  { name: "history", href: "#/history", label: "History" },
  { name: "trends", href: "#/trends", label: "Trends" },
  { name: "boat", href: "#/boat", label: "Context" },
  { name: "boat-tools", href: "#/boat/tools", label: "Tool schemas" },
  { name: "boat-tool-calls", href: "#/boat/tool-calls", label: "Tool calls" },
  { name: "boat-sessions", href: "#/boat/sessions", label: "Sessions" },
  { name: "boat-prompt-mix", href: "#/boat/prompt-mix", label: "Prompt mix" },
]);

function boatSearch(search: URLSearchParams): {
  date?: string;
  recordId?: string;
  offset?: number;
} {
  const date = search.get("date") ?? undefined;
  const recordId = search.get("recordId") ?? undefined;
  const rawOffset = search.get("offset");
  const offset = rawOffset !== null && /^\d+$/.test(rawOffset) ? Number(rawOffset) : undefined;
  return { date, recordId, offset };
}

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
      ) : route.name === "boat" ? (
        <BoatContextPage
          date={boatSearch(route.search).date}
          offset={boatSearch(route.search).offset}
          onSearchChange={(patch) => {
            window.location.hash = hashFor("boat", { ...boatSearch(route.search), ...patch });
          }}
        />
      ) : route.name === "boat-messages" ? (
        <BoatMessagesPage recordId={boatSearch(route.search).recordId} />
      ) : route.name === "boat-prompt" ? (
        <BoatPromptPage recordId={boatSearch(route.search).recordId} />
      ) : route.name === "boat-prompt-mix" ? (
        <BoatPromptMixPage />
      ) : route.name === "boat-prompts" ? (
        <BoatPromptsPage
          hash={(() => {
            const hash = route.search.get("hash") ?? undefined;
            return hash === "" ? undefined : hash;
          })()}
        />
      ) : route.name === "boat-tools" ? (
        <BoatToolsPage />
      ) : route.name === "boat-tool-calls" ? (
        <BoatToolCallsPage />
      ) : route.name === "boat-sessions" ? (
        <BoatSessionsPage />
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
