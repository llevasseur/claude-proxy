import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROUTES } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';

/**
 * The orphan gate for the two API surfaces.
 *
 * Derives two lists from the route manifest and fails by **naming** what reaches no
 * route: an exported `build*`/`apply*` handler in `server/src/api.ts` sitting behind no
 * route, and an exported client function in `apps/admin/src/api.ts` naming no declared
 * path.
 *
 * **A static parse, not a runtime import.** `apps/admin/src/api.ts` reads
 * `import.meta.env`, which only Vite defines, and `apps/admin` has no test suite of its
 * own. The server half is no better at runtime: a handler's link to its route is a
 * textual reference inside the `HANDLERS` map, whose values are closures.
 *
 * The first assertion below — that `HANDLERS`' keys are the manifest's paths — is what
 * lets the rest of the file read `server/src/server.ts` as *the* routed surface.
 *
 * It never deletes. A deliberately-unrouted export is exempted in
 * {@link UNROUTED_BY_DESIGN} with a reason and the entry point that does reach it, both
 * re-checked below.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_API = 'server/src/api.ts';
const SERVER_DISPATCH = 'server/src/server.ts';
const ADMIN_API = 'apps/admin/src/api.ts';

/** An export that reaches no route on purpose. Nothing is skipped without an entry here. */
interface UnroutedExport {
  /** The exported name, as it is written in {@link UnroutedExport.file}. */
  readonly name: string;
  /** The file exporting it, repo-relative. */
  readonly file: string;
  /** The entry point that does reach it — re-checked, so the reason cannot go stale. */
  readonly reachedBy: string | null;
  /** Why it is not an orphan. */
  readonly reason: string;
}

const UNROUTED_BY_DESIGN: readonly UnroutedExport[] = [
  {
    name: 'buildSuggestionBuckets',
    file: SERVER_API,
    reachedBy: 'server/src/suggestions-cli.ts',
    reason:
      'a headless entry point, not an HTTP route: `pnpm --filter server suggestions` builds the windows on the command line.',
  },
  {
    name: 'buildRuleDefects',
    file: SERVER_API,
    reachedBy: 'server/src/suggestions-cli.ts',
    reason: 'the same CLI, reporting which rules misfired. It has never been served over HTTP.',
  },
  {
    name: 'API_BASE',
    file: ADMIN_API,
    reachedBy: null,
    reason:
      'the origin every client function fetches against — configuration, not a call, so it names no path of its own.',
  },
  {
    name: 'PERMISSION_MODES',
    file: ADMIN_API,
    reachedBy: null,
    reason:
      'the permission modes a chat turn may run under, exported for the picker that offers them. A value list, not a call.',
  },
  {
    name: 'CONTEXT_SORTS',
    file: ADMIN_API,
    reachedBy: null,
    reason:
      'the columns `/api/context` will order by, mirrored from the server so the table can only ask for one of them. A value list, not a call.',
  },
  {
    name: 'CONTEXT_PAGE_SIZE',
    file: ADMIN_API,
    reachedBy: null,
    reason:
      'the page size the context table asks for, mirrored from the route that defaults to it. A number, not a call.',
  },
];

const read = (file: string) => readFile(path.join(REPO_ROOT, file), 'utf8');

/** Names of the exempted exports declared for one file. */
const exemptedIn = (file: string) => new Set(UNROUTED_BY_DESIGN.filter((e) => e.file === file).map((e) => e.name));

/** The `build*`/`apply*` handlers `server/src/api.ts` exports — both, as the dispatch imports both. */
function exportedHandlers(source: string): string[] {
  return [...source.matchAll(/^export (?:async function|function|const) ((?:build|apply)[A-Z]\w*)/gm)].map(
    (m) => m[1]!,
  );
}

/** The paths `HANDLERS` in `server/src/server.ts` is keyed by. */
function handlerRoutePaths(source: string): string[] {
  const start = source.indexOf('const HANDLERS: Record<ApiRoutePath, RouteHandler> = {');
  expect(start, `${SERVER_DISPATCH} no longer declares a HANDLERS record keyed by ApiRoutePath`).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('\n};', start));
  return [...block.matchAll(/^ {2}'(\/api\/[^']*)':/gm)].map((m) => m[1]!);
}

/**
 * Every identifier `server/src/server.ts` mentions outside the `./api.js` import list.
 * An imported name appearing nowhere else is imported and never called.
 */
function namesUsedByDispatch(source: string): Set<string> {
  const afterImport = source.slice(source.indexOf("} from './api.js';"));
  return new Set(afterImport.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * The exported `const`s of `apps/admin/src/api.ts`, each with the `/api/…` literals its
 * declaration names. A declaration runs to the next top-level `export const` — that file
 * is one exported arrow per entry throughout.
 */
function clientExports(source: string): { name: string; paths: string[] }[] {
  const lines = source.split('\n');
  const heads: { name: string; line: number }[] = [];
  lines.forEach((line, index) => {
    const match = /^export const (\w+)\s*[=:]/.exec(line);
    if (match) heads.push({ name: match[1]!, line: index });
  });

  return heads.map((head, i) => {
    const end = heads[i + 1]?.line ?? lines.length;
    const body = lines.slice(head.line, end).join('\n');
    return { name: head.name, paths: [...body.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]!) };
  });
}

const MANIFEST_PATHS = new Set<string>(API_ROUTES.map((route) => route.path));

describe('the dispatch table is the manifest', () => {
  it('routes exactly the paths the manifest declares, in both directions', async () => {
    const keys = handlerRoutePaths(await read(SERVER_DISPATCH));

    // Type-enforced by `Record<ApiRoutePath, RouteHandler>`, and asserted anyway: every
    // check below reads `server.ts` as the whole routed surface only while this holds.
    const undeclared = keys.filter((p) => !MANIFEST_PATHS.has(p));
    const unhandled = [...MANIFEST_PATHS].filter((p) => !keys.includes(p));
    expect(undeclared, `handled but not declared:\n${undeclared.join('\n')}`).toEqual([]);
    expect(unhandled, `declared but not handled:\n${unhandled.join('\n')}`).toEqual([]);
  });
});

describe('every exported handler reaches a route', () => {
  it('names every handler in server/src/api.ts that no route reaches', async () => {
    const [api, dispatch] = await Promise.all([read(SERVER_API), read(SERVER_DISPATCH)]);
    const used = namesUsedByDispatch(dispatch);
    const exempt = exemptedIn(SERVER_API);

    const orphans = exportedHandlers(api).filter((name) => !used.has(name) && !exempt.has(name));

    // Not a count. The fix is to delete the function this names, or — if something other
    // than a route reaches it — to add it to UNROUTED_BY_DESIGN with that entry point.
    expect(
      orphans,
      `these handlers sit behind no route in ${SERVER_DISPATCH}:\n${orphans.map((n) => `  ${SERVER_API}: ${n}`).join('\n')}`,
    ).toEqual([]);
  });
});

describe('every exported client function reaches a route', () => {
  it('names every export in apps/admin/src/api.ts that names no declared path', async () => {
    const exports = clientExports(await read(ADMIN_API));
    const exempt = exemptedIn(ADMIN_API);

    const orphans = exports.filter((e) => e.paths.length === 0 && !exempt.has(e.name)).map((e) => e.name);

    expect(
      orphans,
      `these client exports call no route the manifest declares:\n${orphans.map((n) => `  ${ADMIN_API}: ${n}`).join('\n')}`,
    ).toEqual([]);
  });

  it('names every client call to a path the manifest does not declare', async () => {
    const exports = clientExports(await read(ADMIN_API));

    const undeclared = exports.flatMap((e) =>
      e.paths.filter((p) => !MANIFEST_PATHS.has(p)).map((p) => `  ${e.name} -> ${p}`),
    );

    // The other direction of the same drift: a client that outlived its route.
    expect(undeclared, `these calls name no declared route:\n${undeclared.join('\n')}`).toEqual([]);
  });
});

describe('the exemptions stay true', () => {
  it('still finds every exempted export in the file that claims it', async () => {
    const sources = new Map(
      await Promise.all(
        [...new Set(UNROUTED_BY_DESIGN.map((e) => e.file))].map(
          async (file) => [file, await read(file)] as [string, string],
        ),
      ),
    );

    const missing = UNROUTED_BY_DESIGN.filter(
      (entry) =>
        !new RegExp(`^export (?:async function|function|const|type|interface) ${entry.name}\\b`, 'm').test(
          sources.get(entry.file)!,
        ),
    ).map((entry) => `  ${entry.file}: ${entry.name}`);

    // A deleted export keeps its exemption otherwise, and the next orphan hides behind it.
    expect(missing, `exempted exports that no longer exist — drop the entry:\n${missing.join('\n')}`).toEqual([]);
  });

  it('still finds each exempted handler unrouted, so the exemption is doing work', async () => {
    const used = namesUsedByDispatch(await read(SERVER_DISPATCH));

    const nowRouted = UNROUTED_BY_DESIGN.filter((e) => e.file === SERVER_API && used.has(e.name)).map((e) => e.name);

    expect(nowRouted, `exempted but now routed — drop the entry:\n${nowRouted.join('\n')}`).toEqual([]);
  });

  it('still finds the entry point each exemption names reaching it', async () => {
    const named = UNROUTED_BY_DESIGN.filter((e): e is UnroutedExport & { reachedBy: string } => e.reachedBy !== null);
    const sources = new Map(
      await Promise.all(
        [...new Set(named.map((e) => e.reachedBy))].map(async (file) => [file, await read(file)] as [string, string]),
      ),
    );

    const broken = named
      .filter((entry) => !new RegExp(`\\b${entry.name}\\b`).test(sources.get(entry.reachedBy)!))
      .map((entry) => `  ${entry.name}: ${entry.reachedBy} no longer mentions it`);

    // The reason is the exemption. When the CLI stops calling it, it is an orphan again.
    expect(broken, `exemption reasons have gone stale:\n${broken.join('\n')}`).toEqual([]);
  });

  it('gives every exemption a reason', () => {
    for (const entry of UNROUTED_BY_DESIGN) {
      expect(entry.reason.length, entry.name).toBeGreaterThan(20);
    }
  });
});
