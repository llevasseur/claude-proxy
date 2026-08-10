import { createRouter } from '@tanstack/react-router';
import { rootRoute } from './route-root';
import { ROUTES } from './routes/registry';

/**
 * The router, assembled from what the pages declare.
 *
 * There is no route table here any more: each file in `routes/` exports the `route` it
 * is reached by — path, component, title, search validation — and, if it belongs in the
 * side rail, the `nav` station that points at it. `routes/registry.ts` is the one list
 * of those modules, and the root layout in `route-root.tsx` builds the rail off the
 * same list. Moving a page is one file again, rather than that file plus a declaration
 * here plus a nav entry there.
 *
 * `ROUTES` is a readonly tuple, which is what keeps `addChildren` inferring a route
 * tree that still knows every path — see the note on it in the registry.
 */
const routeTree = rootRoute.addChildren(ROUTES);

// `scrollRestoration` snapshots scroll per history entry, so a Back returns to the offset it
// was left at; a forward navigation still starts at the top.
export const router = createRouter({ routeTree, scrollRestoration: true });
