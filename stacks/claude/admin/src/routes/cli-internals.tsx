import type { CliFunctionEntry, CliFunctionMiss } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { Binary } from 'lucide-react';
import { type CliBundleInfo, getCliInternals } from '../api';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonTable } from '../components/Skeleton';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * "CLI internals" — functions inside the Claude Code bundle this machine has
 * installed, each one located in the bundle at read time.
 *
 * The bundle ships minified, so no row is keyed to an identifier. Each is keyed to a
 * **signal** that survives minification — a string literal the function contains, or
 * the source-spelled name a bundler export map binds it to — and the identifier in
 * the Function column is what this version resolved that signal to. When a signal
 * stops matching, the row says so rather than showing the last version's source.
 */

/** Why a row did not resolve, in the page's words. */
const MISS_LABEL = {
  'signal-missing': 'not found in this version',
  'no-match-nearby': 'not found in this version',
  'no-enclosing-function': 'no function around the signal',
} satisfies Record<CliFunctionMiss, string>;

/** The longer form, for the row that needs it. */
const MISS_DETAIL = {
  'signal-missing': 'The signal is not in this bundle at all — the function was renamed past it, changed, or removed.',
  'no-match-nearby': 'The literal is still in the bundle, but never in the shape that identifies this function.',
  'no-enclosing-function': 'The signal is there, but nothing around it parses as a function.',
} satisfies Record<CliFunctionMiss, string>;

/** How a row was identified. */
function SignalCell({ entry }: { entry: CliFunctionEntry }) {
  if (entry.signal.kind === 'export') {
    return (
      <>
        <span className='badge sev-info'>export</span> <span className='rule-name'>{entry.signal.exportName}</span>
      </>
    );
  }
  return (
    <>
      <span className='badge neutral'>literal</span>{' '}
      <span className='rule-name'>{truncate(entry.signal.literal, 48)}</span>
    </>
  );
}

/** Clip a long literal for the table; the detail page shows it in full. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The bundle line under the page title — the version everything below is keyed to. */
function BundleLine({ bundle }: { bundle: CliBundleInfo | undefined }) {
  if (!bundle?.version) return <>Reading the installed Claude Code bundle.</>;
  return (
    <>
      Resolved against Claude Code <span className='rule-name'>{bundle.version}</span>
      {bundle.path && (
        <>
          {' '}
          at <span className='rule-name'>{bundle.path}</span>
        </>
      )}
      . Read-only — nothing here writes to the install.
    </>
  );
}

export function CliInternalsPage() {
  const query = useQuery({ queryKey: ['cli-internals'], queryFn: getCliInternals });
  const navigate = useNavigate();
  const data = query.data;
  const functions = data?.functions ?? [];

  return (
    <section>
      <div className='pagehead'>
        <h1>CLI internals</h1>
        <div className='muted'>
          <BundleLine bundle={data?.bundle} />
        </div>
      </div>

      <div className='card' style={{ marginBottom: 16 }}>
        <div className='leak-note'>
          <strong>Names here are outputs, not keys.</strong> The bundle is minified, so every identifier below is a
          build artefact that changes between releases. Each row is keyed to a signal that survives minification — a
          string literal the function contains, or the name a bundler export map binds it to — and the identifier shown
          is whatever this version resolved that signal to. A row whose signal no longer matches is marked{' '}
          <em>not found in this version</em> rather than showing stale source.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<CliInternalsSkeleton />}>
        {data?.bundle.error !== null && data?.bundle.error !== undefined ? (
          <div className='card empty'>
            {data.bundle.error} Install Claude Code, or point <span className='rule-name'>CLAUDE_CLI_BUNDLE</span> at a
            bundle to read.
          </div>
        ) : functions.length === 0 ? (
          <div className='card empty'>The catalogue is empty.</div>
        ) : (
          <div className='card'>
            <div className='muted'>
              <strong>{data?.meta.resolved ?? 0}</strong> of {functions.length} resolved
              {data?.meta.missing ? <> · {data.meta.missing} not found in this version</> : null}
              {data?.meta.durationMs !== null && data?.meta.durationMs !== undefined && (
                <>
                  {' '}
                  · one pass over {fmtBundleSize(data.bundle.bytes)} in {data.meta.durationMs} ms
                </>
              )}{' '}
              · click a row for its source
            </div>
            <div className='table-scroll' style={{ marginTop: 12 }}>
              <table className='table'>
                <thead>
                  <tr>
                    <th style={FIT_COLUMN}>Function</th>
                    <th>What it does</th>
                    <th style={FIT_COLUMN}>Found by</th>
                  </tr>
                </thead>
                <tbody>
                  {functions.map((f) => (
                    <tr
                      key={f.id}
                      className='clickable'
                      onClick={() => navigate({ to: '/cli-internals/$id', params: { id: f.id } })}>
                      <td style={FIT_COLUMN}>
                        {f.missing === null ? (
                          <span className='rule-name'>{f.signature}</span>
                        ) : (
                          <span className='badge was-present'>{MISS_LABEL[f.missing]}</span>
                        )}
                        <div className='muted'>{f.label}</div>
                      </td>
                      <td>{f.description}</td>
                      <td style={FIT_COLUMN}>
                        <SignalCell entry={f} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** The miss text, re-exported for the detail page. */
export { MISS_DETAIL, MISS_LABEL };

/** Bundle size at whichever scale reads as a number, down to bytes. */
export function fmtBundleSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Shrink-to-fit: the browser gives `1%` columns only what their content needs. */
const FIT_COLUMN = { width: '1%', whiteSpace: 'nowrap' } as const;

const CLI_COLUMNS: readonly SkeletonColumn[] = [{ cell: '70%' }, {}, { cell: '55%' }];

function CliInternalsSkeleton() {
  return (
    <div className='card'>
      <div className='muted' aria-hidden>
        <Skeleton w='38%' />
      </div>
      {/* The real table carries this offset itself. */}
      <div style={{ marginTop: 12 }}>
        <SkeletonTable columns={CLI_COLUMNS} rows={8} />
      </div>
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cli-internals',
  component: CliInternalsPage,
  staticData: { title: 'CLI internals' },
});

export const nav = {
  section: 'Device',
  to: '/cli-internals',
  label: 'CLI internals',
  hint: 'bundle',
  exact: false,
  icon: Binary,
} as const satisfies NavEntry;
