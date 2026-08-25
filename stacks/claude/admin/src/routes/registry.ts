import { nav as adviceNav, providers as adviceProviders, route as adviceRoute } from './advice';
import { providers as cliFunctionProviders, route as cliFunctionRoute } from './cli-function';
import {
  nav as cliInternalsNav,
  providers as cliInternalsProviders,
  route as cliInternalsRoute,
} from './cli-internals';
import { providers as commandDetailProviders, route as commandDetailRoute } from './command-detail';
import { providers as commandRunProviders, route as commandRunRoute } from './command-run';
import { nav as commandsNav, providers as commandsProviders, route as commandsRoute } from './commands';
import { providers as conceptDetailProviders, route as conceptDetailRoute } from './concept-detail';
import { nav as conceptsNav, providers as conceptsProviders, route as conceptsRoute } from './concepts';
import { nav as contextNav, providers as contextProviders, route as contextRoute } from './context';
import { providers as contextDetailProviders, route as contextDetailRoute } from './context-detail';
import { providers as contextMessageProviders, route as contextMessageRoute } from './context-message';
import { providers as contextThreadProviders, route as contextThreadRoute } from './context-thread';
import { providers as contextToolProviders, route as contextToolRoute } from './context-tool';
import { nav as filtersNav, providers as filtersProviders, route as filtersRoute } from './filters';
import {
  nav as hooksPluginsNav,
  providers as hooksPluginsProviders,
  route as hooksPluginsRoute,
} from './hooks-plugins';
import { providers as ideaDetailProviders, route as ideaDetailRoute } from './idea-detail';
import { nav as ideasNav, providers as ideasProviders, route as ideasRoute } from './ideas';
import { providers as jobDetailProviders, route as jobDetailRoute } from './job-detail';
import { nav as jobsNav, providers as jobsProviders, route as jobsRoute } from './jobs';
import { providers as memoryDetailProviders, route as memoryDetailRoute } from './memory-detail';
import type { NavEntry } from './nav';
import { NAV_SECTION_ORDER } from './nav';
import { nav as notesNav, providers as notesProviders, route as notesRoute } from './notes';
import { nav as overviewNav, providers as overviewProviders, route as overviewRoute } from './overview';
import { providers as projectDetailProviders, route as projectDetailRoute } from './project-detail';
import { nav as projectsNav, providers as projectsProviders, route as projectsRoute } from './projects';
import { providers as promptDetailProviders, route as promptDetailRoute } from './prompt-detail';
import { providers as promptSectionProviders, route as promptSectionRoute } from './prompt-section';
import { DEFAULT_PROVIDER, type ProviderId, type ProviderSupport } from './providers';
import {
  nav as pullRequestsNav,
  providers as pullRequestsProviders,
  route as pullRequestsRoute,
} from './pull-requests';
import { providers as sessionDetailProviders, route as sessionDetailRoute } from './session-detail';
import { providers as sessionErrorsProviders, route as sessionErrorsRoute } from './session-errors';
import {
  nav as sessionGraphNav,
  providers as sessionGraphProviders,
  route as sessionGraphRoute,
} from './session-graph';
import { nav as sessionsNav, providers as sessionsProviders, route as sessionsRoute } from './sessions';
import { nav as skimNav, providers as skimProviders, route as skimRoute } from './skim';
import { providers as suggestionBucketProviders, route as suggestionBucketRoute } from './suggestion-bucket';
import {
  nav as systemPromptNav,
  providers as systemPromptProviders,
  route as systemPromptRoute,
} from './system-prompt';
import { providers as toolSchemaProviders, route as toolSchemaRoute } from './tool-schema';
import { nav as toolsNav, providers as toolsProviders, route as toolsRoute } from './tools';
import { providers as trendDetailProviders, route as trendDetailRoute } from './trend-detail';
import { nav as trendsNav, providers as trendsProviders, route as trendsRoute } from './trends';
import { nav as withheldNav, providers as withheldProviders, route as withheldRoute } from './withheld';

/**
 * Every page in the dashboard, in one place. Written out rather than globbed:
 * `import.meta.glob` is typed `Record<string, unknown>` and would erase the route types.
 * Modules are listed in rail order; registration order itself is inert, since TanStack
 * ranks routes by specificity rather than by position.
 *
 * `as const` is load-bearing. A plain array literal widens to `(A | B | …)[]`, and
 * `addChildren` would then build a route tree that has lost which paths exist —
 * `<Link to>` would stop rejecting a bad path and `useParams({ from })` would stop
 * resolving.
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
  notesRoute,
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
 * What each page supports, collected from the `providers` each module declares beside its
 * `route`. **This is the one list**: the side rail below, the redirect guard, and the docs
 * scope filter all read it, and none of them keeps a list of its own — a second list is how
 * a page ends up in the rail under a provider that cannot serve it.
 *
 * `nav` is present only for a page that joins a rail section, exactly as before; a page in
 * no section still declares its providers, which is why the declaration is a field on the
 * module rather than a field inside `nav`.
 *
 * In `ROUTES` order, so "station order is the registry's own order" stays one fact rather
 * than two that can disagree. `as const` is load-bearing here for the same reason it is on
 * `ROUTES`: it is what keeps each `nav.to` a string literal and each `providers` entry a
 * `ProviderId` rather than `string`. The assertions at the foot of this file prove it.
 */
export const MODULE_SUPPORT = [
  { route: overviewRoute, nav: overviewNav, providers: overviewProviders },
  { route: trendsRoute, nav: trendsNav, providers: trendsProviders },
  { route: trendDetailRoute, providers: trendDetailProviders },
  { route: promptDetailRoute, providers: promptDetailProviders },
  { route: promptSectionRoute, providers: promptSectionProviders },
  { route: toolSchemaRoute, providers: toolSchemaProviders },
  { route: contextRoute, nav: contextNav, providers: contextProviders },
  { route: contextThreadRoute, providers: contextThreadProviders },
  { route: contextDetailRoute, providers: contextDetailProviders },
  { route: contextMessageRoute, providers: contextMessageProviders },
  { route: contextToolRoute, providers: contextToolProviders },
  { route: toolsRoute, nav: toolsNav, providers: toolsProviders },
  { route: skimRoute, nav: skimNav, providers: skimProviders },
  { route: withheldRoute, nav: withheldNav, providers: withheldProviders },
  { route: filtersRoute, nav: filtersNav, providers: filtersProviders },
  { route: projectsRoute, nav: projectsNav, providers: projectsProviders },
  { route: projectDetailRoute, providers: projectDetailProviders },
  { route: memoryDetailRoute, providers: memoryDetailProviders },
  { route: sessionsRoute, nav: sessionsNav, providers: sessionsProviders },
  { route: sessionGraphRoute, nav: sessionGraphNav, providers: sessionGraphProviders },
  { route: sessionDetailRoute, providers: sessionDetailProviders },
  { route: sessionErrorsRoute, providers: sessionErrorsProviders },
  { route: pullRequestsRoute, nav: pullRequestsNav, providers: pullRequestsProviders },
  { route: notesRoute, nav: notesNav, providers: notesProviders },
  { route: jobsRoute, nav: jobsNav, providers: jobsProviders },
  { route: jobDetailRoute, providers: jobDetailProviders },
  { route: hooksPluginsRoute, nav: hooksPluginsNav, providers: hooksPluginsProviders },
  { route: systemPromptRoute, nav: systemPromptNav, providers: systemPromptProviders },
  { route: commandsRoute, nav: commandsNav, providers: commandsProviders },
  { route: commandDetailRoute, providers: commandDetailProviders },
  { route: commandRunRoute, providers: commandRunProviders },
  { route: cliInternalsRoute, nav: cliInternalsNav, providers: cliInternalsProviders },
  { route: cliFunctionRoute, providers: cliFunctionProviders },
  { route: conceptsRoute, nav: conceptsNav, providers: conceptsProviders },
  { route: conceptDetailRoute, providers: conceptDetailProviders },
  { route: adviceRoute, nav: adviceNav, providers: adviceProviders },
  { route: suggestionBucketRoute, providers: suggestionBucketProviders },
  { route: ideasRoute, nav: ideasNav, providers: ideasProviders },
  { route: ideaDetailRoute, providers: ideaDetailProviders },
] as const;

/** One page's declaration, as collected above. */
export type ModuleSupport = (typeof MODULE_SUPPORT)[number];

/** A page that joins a rail section — the subset carrying a `nav`. */
export type StationSupport = Extract<ModuleSupport, { nav: NavEntry }>;

/**
 * Whether a page is available under a provider.
 *
 * The parameter is `ProviderSupport` rather than the page's own literal tuple on purpose:
 * `readonly ['anthropic']` has an `includes` that only accepts `'anthropic'`, so asking it
 * about another provider would be a type error rather than the `false` the caller wants.
 */
export function supportsProvider(providers: ProviderSupport, provider: ProviderId): boolean {
  return providers.includes(provider);
}

/**
 * The pages that appear in the rail, in rail order — the nav-carrying subset of the one
 * list above. A page with no `nav` is simply absent, which is how "in no section" is
 * expressed, and the order is `MODULE_SUPPORT`'s own.
 */
const STATIONS = MODULE_SUPPORT.filter((m): m is StationSupport => 'nav' in m);

/**
 * The rail for one provider: sections in `NAV_SECTION_ORDER`, stations within a section in
 * registry order, and a station the provider does not support left **out** rather than
 * rendered disabled — a greyed row invites a click that cannot work
 * ([ADR 0041](../../../../../docs/adrs/0041-provider-picker-drives-the-navigation.md)).
 *
 * Filtering a readonly tuple yields an array of the element *union*, so `to` survives as
 * the union of path literals rather than widening to `string`.
 */
export function navRailFor(provider: ProviderId) {
  return NAV_SECTION_ORDER.map((label) => ({
    label,
    stations: STATIONS.filter((s) => s.nav.section === label && supportsProvider(s.providers, provider)).map(
      (s) => s.nav,
    ),
  }));
}

/**
 * The rail as rendered today. The picker that will vary the provider is a later campaign;
 * until it lands the rail is the default provider's, which per ADR 0041 is Anthropic — so
 * this is the same rail as before this declaration existed.
 */
export const NAV_RAIL = navRailFor(DEFAULT_PROVIDER);

/**
 * Type-level guards for the three things that degrade **silently** — no runtime check and
 * no other gate would catch any of them, and `typecheck` is this package's only gate.
 *
 * Each is written so the widened form makes the conditional resolve to `never`, which the
 * `true` initializer then fails to satisfy. Deleting an assertion is visible in a diff;
 * widening the thing it guards is not, which is the whole point of writing them down.
 */
type Assert<T extends true> = T;

/**
 * A `nav` written `: NavEntry` instead of `as const satisfies NavEntry` widens `to` to
 * `string`, and `<Link to>` silently stops rejecting a bad path.
 */
export type _NavToStaysLiteral = Assert<string extends StationSupport['nav']['to'] ? false : true>;

/**
 * A `providers` written `: ProviderSupport` instead of `as const satisfies ProviderSupport`
 * still has `ProviderId` entries, so testing the entry type against `string` would pass it.
 * What is actually lost is *which* providers the page named, so the test is tuple identity:
 * if any page's declaration is the general `ProviderSupport` rather than its own literal
 * tuple, `ProviderSupport` becomes assignable to this union and the assertion fails.
 */
export type _ProvidersStayLiteral = Assert<ProviderSupport extends ModuleSupport['providers'] ? false : true>;

/**
 * Every route in `ROUTES` has a declaration in `MODULE_SUPPORT`. Adding a page without
 * declaring its providers is then a compile error rather than a page that quietly appears
 * under every provider.
 */
export type _EveryRouteIsDeclared = Assert<
  (typeof MODULE_SUPPORT)['length'] extends (typeof ROUTES)['length'] ? true : false
>;
