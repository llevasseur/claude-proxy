import { createRootRoute, createRoute, createRouter, Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Binary,
  BookOpen,
  EyeOff,
  FolderGit2,
  Gauge,
  GitPullRequest,
  HardDrive,
  Lightbulb,
  ListFilter,
  Menu,
  MessagesSquare,
  Monitor,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  ScrollText,
  Sparkles,
  TerminalSquare,
  TrendingUp,
  Wrench,
  Zap,
} from 'lucide-react';
import { useEffect } from 'react';
import { HealthBadge } from './components/HealthBadge';
import { AdvicePage } from './routes/advice';
import { CliFunctionPage } from './routes/cli-function';
import { CliInternalsPage } from './routes/cli-internals';
import { CommandDetailPage } from './routes/command-detail';
import { CommandRunPage } from './routes/command-run';
import { CommandsPage } from './routes/commands';
import { ConceptDetailPage } from './routes/concept-detail';
import { ConceptsPage } from './routes/concepts';
import { ContextPage } from './routes/context';
import { ContextDetailPage } from './routes/context-detail';
import { ContextMessagePage } from './routes/context-message';
import { ContextThreadPage } from './routes/context-thread';
import { ContextToolPage } from './routes/context-tool';
import { FiltersPage } from './routes/filters';
import { HooksPluginsPage } from './routes/hooks-plugins';
import { IdeaDetailPage } from './routes/idea-detail';
import { IdeasPage } from './routes/ideas';
import { JobDetailPage } from './routes/job-detail';
import { JobsPage } from './routes/jobs';
import { MemoryDetailPage } from './routes/memory-detail';
import { OverviewPage } from './routes/overview';
import { ProjectDetailPage } from './routes/project-detail';
import { ProjectsPage } from './routes/projects';
import { PromptDetailPage } from './routes/prompt-detail';
import { PromptSectionPage } from './routes/prompt-section';
import { PullRequestsPage } from './routes/pull-requests';
import { SessionDetailPage } from './routes/session-detail';
import { SessionErrorsPage } from './routes/session-errors';
import { SessionGraphPage } from './routes/session-graph';
import { SessionsPage } from './routes/sessions';
import { SkimPage } from './routes/skim';
import { SuggestionBucketPage } from './routes/suggestion-bucket';
import { SystemPromptPage } from './routes/system-prompt';
import { ToolSchemaPage } from './routes/tool-schema';
import { ToolsPage } from './routes/tools';
import { TrendDetailPage } from './routes/trend-detail';
import { TrendsPage } from './routes/trends';
import { WithheldPage } from './routes/withheld';
import { useNavDrawer } from './useNavDrawer';
import { useRailCollapsed } from './useRailCollapsed';

/** Side-rail nav stations, grouped into sections. A section labels its stations; it is never a destination. */
const NAV_SECTIONS = [
  {
    label: 'Dashboard',
    stations: [
      { to: '/', label: 'Overview', hint: 'today', exact: true, icon: Monitor },
      // Not exact: `/trends/$metric` keeps the station lit.
      { to: '/trends', label: 'Trends', hint: 'blended', exact: false, icon: TrendingUp },
    ],
  },
  {
    label: 'Context',
    stations: [
      { to: '/context', label: 'Context size', hint: 'prompt', exact: false, icon: Gauge },
      { to: '/tools', label: 'Tool bloat', hint: 'context', exact: false, icon: Wrench },
      { to: '/skim', label: 'Skim', hint: 'cache', exact: false, icon: Zap },
      { to: '/withheld', label: 'Not added', hint: 'withheld', exact: false, icon: EyeOff },
      { to: '/filters', label: 'Proxy filters', hint: 'stripped', exact: false, icon: ListFilter },
    ],
  },
  {
    label: 'Sessions',
    stations: [
      { to: '/projects', label: 'Projects', hint: 'memory', exact: false, icon: FolderGit2 },
      { to: '/sessions', label: 'Sessions', hint: 'transcripts', exact: true, icon: MessagesSquare },
      { to: '/sessions/graph', label: 'Live graph', hint: 'sessions', exact: false, icon: Network },
    ],
  },
  {
    label: 'Activity',
    stations: [
      { to: '/pull-requests', label: 'Pull requests', hint: 'github', exact: false, icon: GitPullRequest },
      { to: '/jobs', label: 'Jobs', hint: 'device', exact: false, icon: HardDrive },
    ],
  },
  {
    label: 'Device',
    stations: [
      { to: '/hooks-plugins', label: 'Hooks & Plugins', hint: 'config', exact: false, icon: Puzzle },
      { to: '/system-prompt', label: 'System prompt', hint: 'device', exact: false, icon: ScrollText },
      { to: '/commands', label: 'Commands', hint: 'per step', exact: false, icon: TerminalSquare },
      { to: '/cli-internals', label: 'CLI internals', hint: 'bundle', exact: false, icon: Binary },
    ],
  },
  {
    label: 'Learning',
    stations: [
      { to: '/concepts', label: 'Concepts', hint: '/teach', exact: false, icon: BookOpen },
      { to: '/advice', label: 'Advice', hint: 'coaching', exact: false, icon: Lightbulb },
      // Beside Advice, which kept the coaching and handed the ledger over to this page.
      { to: '/ideas', label: 'Ideas', hint: 'by area', exact: false, icon: Sparkles },
    ],
  },
] as const;

/** DOM id for a nav section's heading. */
function navGroupId(label: string): string {
  return `nav-group-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Scroll the document to the top, jumping rather than animating under `prefers-reduced-motion`. */
function scrollToTop(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

/** Browser-tab title for a route, appended after the ClaudeProxy brand. */
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: string;
  }
}

const BRAND = 'ClaudeProxy';

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
  // The live graph and the Sessions chat go full-bleed; every other page keeps the padded column.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const full = pathname === '/sessions/graph' || pathname === '/sessions';
  const [collapsed, toggleRail] = useRailCollapsed();
  const toggleLabel = collapsed ? 'Expand navigation' : 'Collapse navigation';
  const nav = useNavDrawer();
  return (
    <div className={`app${collapsed ? ' app--rail-collapsed' : ''}${nav.open ? ' app--drawer-open' : ''}`}>
      <aside className='rail' id='rail-nav'>
        <div className='rail-head'>
          <span className='brand-node' aria-hidden />
          <span className='brand'>
            claude<span className='brand-sep'>·</span>proxy
          </span>
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

        <nav className='stations' aria-label='Primary'>
          {NAV_SECTIONS.map((section) => (
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
        </div>
        <main className={`content${full ? ' content--full' : ''}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  staticData: { title: 'Overview' },
});
/**
 * End-of-day snapshots of every metric, blended across the window. `/trends/$metric`
 * below is a sibling route, not a child.
 */
const trendsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trends',
  component: TrendsPage,
  staticData: { title: 'Trends' },
});
const trendDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trends/$metric',
  component: TrendDetailPage,
  staticData: { title: 'Trend' },
});
const promptDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Nested under the metric it drills into. The param is the prompt's content
  // hash, which is also its cohort key on that page.
  path: '/trends/avg-system-prompt/$hash',
  component: PromptDetailPage,
  staticData: { title: 'System prompt' },
});
const promptSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  // The index is into the prompt's own ranked section table, not the outline.
  path: '/trends/avg-system-prompt/$hash/section/$index',
  component: PromptSectionPage,
  staticData: { title: 'Prompt section' },
});
const toolSchemaRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Nested under the metric it drills into. The param is the tool's wire name,
  // which is what the schema is looked up by.
  path: '/trends/fixed-prefix/tool/$name',
  component: ToolSchemaPage,
  staticData: { title: 'Tool schema' },
});
const contextRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/context',
  component: ContextPage,
  staticData: { title: 'Context size' },
});
/** `?days=` clamped to 1–365 the way `/api/context` clamps it; anything unreadable
 * falls back to the default rather than erroring. */
function contextDays(raw: unknown): number {
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.min(Math.round(days), 365) : 14;
}
/** `?days=` carries the window the thread was reached from. */
export interface ContextThreadSearch {
  days: number;
}
const contextThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  // A static segment, so it can never be read as a `$file` drill-down.
  path: '/context/thread/$threadId',
  component: ContextThreadPage,
  staticData: { title: 'Context thread' },
  validateSearch: (search: Record<string, unknown>): ContextThreadSearch => ({ days: contextDays(search.days) }),
});
/** `?thread=` names the thread this request was reached through — the only way the
 * breakdown can crumb back, since a request body records no ids. `?days=` rides
 * along so that crumb reopens the window it came from. */
export interface ContextDetailSearch {
  thread?: string;
  days?: number;
}
const contextDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/context/$file',
  component: ContextDetailPage,
  staticData: { title: 'Context size' },
  validateSearch: (search: Record<string, unknown>): ContextDetailSearch => {
    const thread = search.thread;
    if (typeof thread !== 'string' || thread === '') return {};
    return { thread, days: contextDays(search.days) };
  },
});
const contextMessageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/context/$file/message/$index',
  component: ContextMessagePage,
  staticData: { title: 'Context message' },
});
const contextToolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/context/$file/tool/$index',
  component: ContextToolPage,
  staticData: { title: 'Context tool call' },
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
  staticData: { title: 'Projects' },
});
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project',
  component: ProjectDetailPage,
  staticData: { title: 'Project' },
});
const memoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project/memory/$name',
  component: MemoryDetailPage,
  staticData: { title: 'Memory' },
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsPage,
  staticData: { title: 'Sessions' },
});
/** `?session=` names the session the graph opens on. */
export interface SessionGraphSearch {
  session?: string;
}
const sessionGraphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/graph',
  component: SessionGraphPage,
  staticData: { title: 'Live graph' },
  validateSearch: (search: Record<string, unknown>): SessionGraphSearch => {
    const session = search.session;
    return typeof session === 'string' && session !== '' ? { session } : {};
  },
});
const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$id',
  component: SessionDetailPage,
  staticData: { title: 'Session' },
});
const sessionErrorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$id/errors',
  component: SessionErrorsPage,
  staticData: { title: 'Session errors' },
});
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: JobsPage,
  staticData: { title: 'Jobs' },
});
const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs/$id',
  component: JobDetailPage,
  staticData: { title: 'Job' },
});
const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tools',
  component: ToolsPage,
  staticData: { title: 'Tool bloat' },
});
const skimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/skim',
  component: SkimPage,
  staticData: { title: 'Skim' },
});
const withheldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/withheld',
  component: WithheldPage,
  staticData: { title: 'Not added' },
});
const filtersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/filters',
  component: FiltersPage,
  staticData: { title: 'Proxy filters' },
});
const pullRequestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pull-requests',
  component: PullRequestsPage,
  staticData: { title: 'Pull requests' },
});
const hooksPluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hooks-plugins',
  component: HooksPluginsPage,
  staticData: { title: 'Hooks & Plugins' },
});
const systemPromptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/system-prompt',
  component: SystemPromptPage,
  staticData: { title: 'System prompt' },
});
const cliInternalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cli-internals',
  component: CliInternalsPage,
  staticData: { title: 'CLI internals' },
});
const cliFunctionRoute = createRoute({
  getParentRoute: () => rootRoute,
  // `$id` is the catalogue's own key, which is stable where the minified name is not.
  path: '/cli-internals/$id',
  component: CliFunctionPage,
  staticData: { title: 'CLI function' },
});
const conceptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/concepts',
  component: ConceptsPage,
  staticData: { title: 'Concepts' },
});
const conceptDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  // `$ord` is the line the record sits on in the store — unique where a term is not.
  path: '/concepts/$ord',
  component: ConceptDetailPage,
  staticData: { title: 'Concept' },
});
const adviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/advice',
  component: AdvicePage,
  staticData: { title: 'Advice' },
});
/**
 * `?area=` is the selected tab, so a filtered view is linkable and survives a
 * reload. An unreadable one is dropped here and the page falls back to its
 * default view — a renamed or deleted area must degrade, never error.
 */
export interface IdeasSearch {
  area?: string;
}
const ideasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ideas',
  component: IdeasPage,
  staticData: { title: 'Ideas' },
  validateSearch: (search: Record<string, unknown>): IdeasSearch => {
    const area = search.area;
    return typeof area === 'string' && area !== '' ? { area } : {};
  },
});
const ideaDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  // The slug alone: the area is never in a permalink, so re-filing cannot break a link.
  path: '/ideas/$slug',
  component: IdeaDetailPage,
  staticData: { title: 'Idea' },
});
const suggestionBucketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/advice/sessions/$bucket',
  component: SuggestionBucketPage,
  staticData: { title: 'Session suggestions' },
});
const commandsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/commands',
  component: CommandsPage,
  staticData: { title: 'Commands' },
});
const commandDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/commands/$command',
  component: CommandDetailPage,
  staticData: { title: 'Command' },
});
const commandRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  // The run id, not the thread id: a nested run shares its host's session.
  path: '/commands/$command/$runId',
  component: CommandRunPage,
  staticData: { title: 'Command run' },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  trendsRoute,
  trendDetailRoute,
  promptDetailRoute,
  promptSectionRoute,
  toolSchemaRoute,
  contextRoute,
  contextThreadRoute,
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
  jobsRoute,
  jobDetailRoute,
  toolsRoute,
  skimRoute,
  withheldRoute,
  filtersRoute,
  pullRequestsRoute,
  hooksPluginsRoute,
  systemPromptRoute,
  cliInternalsRoute,
  cliFunctionRoute,
  conceptsRoute,
  conceptDetailRoute,
  adviceRoute,
  ideasRoute,
  ideaDetailRoute,
  suggestionBucketRoute,
  commandsRoute,
  commandDetailRoute,
  commandRunRoute,
]);

// `scrollRestoration` snapshots scroll per history entry, so a Back returns to the offset it
// was left at; a forward navigation still starts at the top.
export const router = createRouter({ routeTree, scrollRestoration: true });
