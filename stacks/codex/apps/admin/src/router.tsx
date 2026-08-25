import { createRootRoute, createRoute, createRouter, useMatches } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppShell, OverviewPage } from './App.tsx';
import { DEFAULT_HISTORY_PAGE_SIZE } from './car/api.ts';
import { HistoryPage } from './car/history-page.tsx';
import { validateCarSearch, validateHistorySearch } from './car/search-params.ts';
import { TrendsPage } from './car/trends-page.tsx';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: string;
  }
}

function stringifyRepeatedSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
    } else if (typeof value === 'object') {
      params.set(key, JSON.stringify(value));
    } else {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

const rootRoute = createRootRoute({
  component: function RootView() {
    return (
      <>
        <TitleSync />
        <AppShell />
      </>
    );
  },
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  staticData: { title: 'Overview' },
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  validateSearch: validateHistorySearch,
  staticData: { title: 'History' },
  component: function HistoryRouteView() {
    const search = historyRoute.useSearch();
    const navigate = historyRoute.useNavigate();
    return (
      <HistoryPage
        filters={search}
        page={search.page ?? 1}
        pageSize={search.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE}
        onSearchChange={(next) => {
          void navigate({ search: (previous) => ({ ...previous, ...next }) });
        }}
      />
    );
  },
});

const trendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trends',
  validateSearch: validateCarSearch,
  staticData: { title: 'Trends' },
  component: function TrendsRouteView() {
    const search = trendsRoute.useSearch();
    const navigate = trendsRoute.useNavigate();
    return (
      <TrendsPage
        filters={search}
        onSearchChange={(next) => {
          void navigate({ search: (previous) => ({ ...previous, ...next }) });
        }}
      />
    );
  },
});

function TitleSync() {
  const matches = useMatches();
  useEffect(() => {
    const titled = [...matches].reverse().find((match) => match.staticData.title);
    document.title = `CodexProxy · ${titled?.staticData.title ?? 'Overview'}`;
  }, [matches]);
  return null;
}

const routeTree = rootRoute.addChildren([overviewRoute, historyRoute, trendsRoute]);

export const router = createRouter({
  routeTree,
  context: undefined,
  defaultPreload: 'intent',
  stringifySearch: stringifyRepeatedSearch,
});
