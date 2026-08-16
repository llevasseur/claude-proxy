import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect } from 'react';
import { HealthBadge } from './components/HealthBadge';
import { NAV_RAIL } from './routes/registry';
import { useNavDrawer } from './useNavDrawer';
import { useRailCollapsed } from './useRailCollapsed';
import { useStationInView } from './useStationInView';

/**
 * The root route and the chrome every page renders inside.
 *
 * This lives apart from `router.tsx` so a page file can name its parent without importing
 * the router it is a child of. The remaining cycle — `registry` imports the page files,
 * they import `rootRoute` from here, and this file imports the rail back off `registry` —
 * is benign: every read is deferred, `getParentRoute` being a thunk and `NAV_RAIL` being
 * read inside a component body.
 */

/** Browser-tab title for a route, appended after the ClaudeProxy brand. */
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: string;
  }
}

/** DOM id for a nav section's heading. */
function navGroupId(label: string): string {
  return `nav-group-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Scroll the document to the top, jumping rather than animating under `prefers-reduced-motion`. */
function scrollToTop(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

const BRAND = 'ClaudeProxy';

/** The wordmark, linking to Overview. Rendered twice: the rail's head hides below the drawer breakpoint, where the top bar carries it instead. */
function BrandLink({
  className,
  pathname,
  closeDrawer,
}: {
  className: string;
  pathname: string;
  closeDrawer: () => void;
}) {
  return (
    <Link
      to='/'
      className={className}
      aria-label='claude·proxy — Overview'
      onClick={(e) => {
        // Already on Overview: scroll up rather than re-navigate, as a lit station does.
        if (pathname !== '/') return;
        // A modified click is opening a tab, not navigating here.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        closeDrawer();
        scrollToTop();
      }}>
      <span className='brand-node' aria-hidden />
      <span className='brand'>
        claude<span className='brand-sep'>·</span>proxy
      </span>
    </Link>
  );
}

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
  const activeProps = { className: 'station active' };
  useDocumentTitle();
  // The live graph, Sessions chat, and Notes editor go full-bleed; every other page keeps the padded column.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const full = pathname === '/sessions/graph' || pathname === '/sessions' || pathname === '/notes';
  const [collapsed, toggleRail] = useRailCollapsed();
  const toggleLabel = collapsed ? 'Expand navigation' : 'Collapse navigation';
  const nav = useNavDrawer();
  const stations = useStationInView(pathname, nav.open);
  return (
    <div className={`app${collapsed ? ' app--rail-collapsed' : ''}${nav.open ? ' app--drawer-open' : ''}`}>
      <aside className='rail' id='rail-nav'>
        <div className='rail-head'>
          <BrandLink className='brand-link' pathname={pathname} closeDrawer={nav.close} />
          <button
            type='button'
            className='rail-toggle'
            onClick={toggleRail}
            aria-pressed={collapsed}
            aria-label={toggleLabel}
            title={toggleLabel}>
            {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
          </button>
        </div>

        <nav className='stations' aria-label='Primary' ref={stations}>
          {NAV_RAIL.map((section) => (
            // biome-ignore lint/a11y/useSemanticElements: the suggested <fieldset> groups form controls; this groups nav links, and a nested <nav> per section would add six landmarks to the rail
            <div key={section.label} className='nav-group' role='group' aria-labelledby={navGroupId(section.label)}>
              <h2 className='nav-group-label' id={navGroupId(section.label)}>
                {section.label}
              </h2>
              {section.stations.map((s) => (
                <Link
                  key={s.to}
                  to={s.to}
                  className='station'
                  activeProps={activeProps}
                  activeOptions={s.exact ? { exact: true } : undefined}
                  title={collapsed ? s.label : undefined}
                  onClick={(e) => {
                    // Exact pathname, not lit state: a `/trends` station lit under `/trends/$metric` still navigates.
                    if (pathname !== s.to) return;
                    // A modified click is opening a tab, not navigating here.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    // On a narrow viewport the drawer covers the page it just scrolled.
                    nav.close();
                    scrollToTop();
                  }}>
                  <s.icon className='station-icon' size={17} strokeWidth={1.75} aria-hidden />
                  <span className='station-label'>{s.label}</span>
                  <span className='station-hint'>{s.hint}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className='rail-foot'>
          <HealthBadge />
        </div>
      </aside>

      {/* Anywhere off the drawer closes it; a station sits above the scrim, so picking one leaves it open. */}
      {nav.open && (
        <button type='button' className='rail-scrim' tabIndex={-1} aria-label='Close navigation' onClick={nav.close} />
      )}

      <div className='workspace'>
        <div className='topbar'>
          <button
            type='button'
            className='drawer-toggle'
            onClick={nav.toggle}
            aria-expanded={nav.open}
            aria-controls='rail-nav'
            aria-label='Open navigation'
            title='Open navigation'>
            <Menu size={20} aria-hidden />
          </button>
          <BrandLink className='brand-link topbar-brand' pathname={pathname} closeDrawer={nav.close} />
        </div>
        <main className={`content${full ? ' content--full' : ''}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
