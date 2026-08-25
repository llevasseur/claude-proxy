import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { getCliFunction } from '../api';
import { QueryState } from '../components/QueryState';
import { Segmented, type SegmentedOption } from '../components/Segmented';
import { Skeleton, SkeletonText } from '../components/Skeleton';
import { fmtInt } from '../format';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';
import { fmtBundleSize, MISS_DETAIL, MISS_LABEL } from './cli-internals';
import type { ProviderSupport } from './providers';

/**
 * One catalogued CLI function: how it was found, what this version minified it to,
 * and its source read straight back out of the bundle at the offset the index pass
 * recorded — never reconstructed, never cached from an earlier version.
 *
 * The source is minified, so a single function is routinely several thousand
 * characters on one line. Wrapped is the default; Unwrapped keeps the original line
 * structure and scrolls.
 */

type SourceView = 'wrapped' | 'unwrapped';

/** Wrapped fits the column; unwrapped preserves the line exactly. */
const SOURCE_VIEWS: readonly SegmentedOption<SourceView>[] = [
  { value: 'wrapped', label: 'Wrapped' },
  { value: 'unwrapped', label: 'Unwrapped' },
];

export function CliFunctionPage() {
  const { id } = useParams({ from: '/cli-internals/$id' });
  const query = useQuery({ queryKey: ['cli-function', id], queryFn: () => getCliFunction(id) });
  const [view, setView, isSwitching] = useTransitionState<SourceView>('wrapped');
  const data = query.data;
  const fn = data?.function;

  return (
    <section>
      <div className='pagehead'>
        <h1>{fn?.label ?? 'CLI function'}</h1>
        <div className='muted'>
          <Link to='/cli-internals' className='link'>
            All CLI internals
          </Link>
          {data?.bundle.version && (
            <>
              {' '}
              · Claude Code <span className='rule-name'>{data.bundle.version}</span>
            </>
          )}
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<CliFunctionSkeleton />}>
        {!fn ? null : (
          <>
            <div className='card' style={{ marginBottom: 16 }}>
              <div className='muted'>{fn.description}</div>
              <div className='table-scroll' style={{ marginTop: 12 }}>
                <table className='table'>
                  <tbody>
                    <tr>
                      <td style={FIT_COLUMN}>Identifier in this version</td>
                      <td>
                        {fn.missing === null ? (
                          <span className='rule-name'>{fn.signature}</span>
                        ) : (
                          <span className='badge was-present'>{MISS_LABEL[fn.missing]}</span>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td style={FIT_COLUMN}>Found by</td>
                      <td>
                        {fn.signal.kind === 'export' ? (
                          <>
                            <span className='badge sev-info'>export name</span>{' '}
                            <span className='rule-name'>{fn.signal.exportName}</span>
                          </>
                        ) : (
                          <>
                            <span className='badge neutral'>string literal</span>{' '}
                            <span className='rule-name'>{fn.signal.literal}</span>
                            {fn.signal.near && (
                              <div className='muted' style={{ marginTop: 4 }}>
                                narrowed to occurrences matching <span className='rule-name'>{fn.signal.near}</span>
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                    {fn.offset !== null && fn.length !== null && (
                      <tr>
                        <td style={FIT_COLUMN}>Where in the bundle</td>
                        <td className='muted'>
                          byte {fmtInt(fn.offset)}, {fmtInt(fn.length)} bytes long
                          {data.bundle.bytes > 0 && <> · bundle is {fmtBundleSize(data.bundle.bytes)}</>}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td style={FIT_COLUMN}>Catalogue id</td>
                      <td className='rule-name'>{fn.id}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {fn.missing !== null || data.source === null ? (
              <div className='card empty'>
                <strong>Not found in Claude Code {data.bundle.version ?? 'this version'}.</strong>{' '}
                {fn.missing === null
                  ? 'The function resolved, but its source could not be read back out of the bundle.'
                  : MISS_DETAIL[fn.missing]}{' '}
                Nothing is shown rather than source from a version that is no longer installed.
              </div>
            ) : (
              <div className='card'>
                <div className='card-head'>
                  <h2>Source</h2>
                  <Segmented
                    options={SOURCE_VIEWS}
                    value={view}
                    onSelect={setView}
                    label='Source view'
                    busy={isSwitching}
                  />
                </div>
                <div className={isSwitching ? 'is-stale' : undefined}>
                  <pre className={view === 'wrapped' ? 'rawjson wrap' : 'rawjson'}>{data.source}</pre>
                </div>
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Shrink-to-fit: the browser gives `1%` columns only what their content needs. */
const FIT_COLUMN = { width: '1%', whiteSpace: 'nowrap' } as const;

function CliFunctionSkeleton() {
  return (
    <>
      <div className='card' style={{ marginBottom: 16 }} aria-hidden>
        <SkeletonText lines={2} />
      </div>
      <div className='card' aria-hidden>
        <div className='card-head'>
          <Skeleton w='18%' />
        </div>
        <SkeletonText lines={6} />
      </div>
    </>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  // `$id` is the catalogue's own key, which is stable where the minified name is not.
  path: '/cli-internals/$id',
  component: CliFunctionPage,
  staticData: { title: 'CLI function' },
});

/** One function inside the Claude Code CLI bundle. */
export const providers = ['anthropic'] as const satisfies ProviderSupport;
