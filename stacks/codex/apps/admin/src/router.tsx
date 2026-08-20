import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppShell, OverviewPage } from './App.tsx';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: string;
  }
}

const rootRoute = createRootRoute({ component: AppShell });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  staticData: { title: 'Overview' },
});

function TitleSync() {
  useEffect(() => {
    document.title = 'CodexProxy · Overview';
  }, []);
  return null;
}

const routeTree = rootRoute.addChildren([overviewRoute]);

export const router = createRouter({
  routeTree,
  context: undefined,
  defaultPreload: 'intent',
  Wrap: ({ children }) => (
    <>
      <TitleSync />
      {children}
    </>
  ),
});
