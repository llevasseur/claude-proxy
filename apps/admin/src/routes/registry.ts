import { nav as adviceNav, route as adviceRoute } from './advice';
import { route as cliFunctionRoute } from './cli-function';
import { nav as cliInternalsNav, route as cliInternalsRoute } from './cli-internals';
import { route as commandDetailRoute } from './command-detail';
import { route as commandRunRoute } from './command-run';
import { nav as commandsNav, route as commandsRoute } from './commands';
import { route as conceptDetailRoute } from './concept-detail';
import { nav as conceptsNav, route as conceptsRoute } from './concepts';
import { nav as contextNav, route as contextRoute } from './context';
import { route as contextDetailRoute } from './context-detail';
import { route as contextMessageRoute } from './context-message';
import { route as contextThreadRoute } from './context-thread';
import { route as contextToolRoute } from './context-tool';
import { nav as filtersNav, route as filtersRoute } from './filters';
import { nav as hooksPluginsNav, route as hooksPluginsRoute } from './hooks-plugins';
import { route as ideaDetailRoute } from './idea-detail';
import { nav as ideasNav, route as ideasRoute } from './ideas';
import { route as jobDetailRoute } from './job-detail';
import { nav as jobsNav, route as jobsRoute } from './jobs';
import { route as memoryDetailRoute } from './memory-detail';
import { NAV_SECTION_ORDER } from './nav';
import { nav as overviewNav, route as overviewRoute } from './overview';
import { route as projectDetailRoute } from './project-detail';
import { nav as projectsNav, route as projectsRoute } from './projects';
import { route as promptDetailRoute } from './prompt-detail';
import { route as promptSectionRoute } from './prompt-section';
import { nav as pullRequestsNav, route as pullRequestsRoute } from './pull-requests';
import { route as sessionDetailRoute } from './session-detail';
import { route as sessionErrorsRoute } from './session-errors';
import { nav as sessionGraphNav, route as sessionGraphRoute } from './session-graph';
import { nav as sessionsNav, route as sessionsRoute } from './sessions';
import { nav as skimNav, route as skimRoute } from './skim';
import { route as suggestionBucketRoute } from './suggestion-bucket';
import { nav as systemPromptNav, route as systemPromptRoute } from './system-prompt';
import { route as toolSchemaRoute } from './tool-schema';
import { nav as toolsNav, route as toolsRoute } from './tools';
import { route as trendDetailRoute } from './trend-detail';
import { nav as trendsNav, route as trendsRoute } from './trends';
import { nav as withheldNav, route as withheldRoute } from './withheld';

/**
 * Every page in the dashboard, in one place.
 *
 * The list is written out rather than globbed. `import.meta.glob` would be shorter, but
 * it is a Vite feature typed as `Record<string, unknown>`, which would erase the route
 * types this whole arrangement exists to keep — and it would hide the list, which is
 * the one thing a registry is for. Adding a page is still two edits: the file, and a
 * line here.
 *
 * Modules are listed in rail order, so a section's stations read down this list in the
 * order they appear in the nav. Route *registration* order is inert — TanStack ranks
 * routes by specificity, not by position — so ordering it for the nav's benefit costs
 * nothing.
 */

/**
 * `as const` is load-bearing. A plain array literal widens to `(A | B | …)[]`, and
 * `addChildren` would then build a route tree that has lost which paths exist —
 * `<Link to>` would stop rejecting a bad path and `useParams({ from })` would stop
 * resolving. The readonly tuple keeps each route's own type in its own slot.
 */
export const ROUTES = [
  overviewRoute,
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
  toolsRoute,
  skimRoute,
  withheldRoute,
  filtersRoute,
  projectsRoute,
  projectDetailRoute,
  memoryDetailRoute,
  sessionsRoute,
  sessionGraphRoute,
  sessionDetailRoute,
  sessionErrorsRoute,
  pullRequestsRoute,
  jobsRoute,
  jobDetailRoute,
  hooksPluginsRoute,
  systemPromptRoute,
  commandsRoute,
  commandDetailRoute,
  commandRunRoute,
  cliInternalsRoute,
  cliFunctionRoute,
  conceptsRoute,
  conceptDetailRoute,
  adviceRoute,
  suggestionBucketRoute,
  ideasRoute,
  ideaDetailRoute,
] as const;

/**
 * The pages that appear in the rail, in rail order. A page with no `nav` export is
 * simply absent here — that is how "in no section" is expressed.
 *
 * `as const` for the same reason as `ROUTES`: it keeps each entry's `to` a string
 * literal, so the union that reaches `<Link to>` is still the set of real paths.
 */
const STATIONS = [
  overviewNav,
  trendsNav,
  contextNav,
  toolsNav,
  skimNav,
  withheldNav,
  filtersNav,
  projectsNav,
  sessionsNav,
  sessionGraphNav,
  pullRequestsNav,
  jobsNav,
  hooksPluginsNav,
  systemPromptNav,
  commandsNav,
  cliInternalsNav,
  conceptsNav,
  adviceNav,
  ideasNav,
] as const;

/**
 * The rail, grouped and ordered: sections in `NAV_SECTION_ORDER`, stations within a
 * section in `STATIONS` order. Filtering a readonly tuple yields an array of the
 * element *union*, so `to` survives as the union of path literals rather than widening
 * to `string`.
 */
export const NAV_RAIL = NAV_SECTION_ORDER.map((label) => ({
  label,
  stations: STATIONS.filter((s) => s.section === label),
}));
