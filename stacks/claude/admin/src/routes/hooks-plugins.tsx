import type { AliasLoadExpectation } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
import { getHooksPlugins } from '../api';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonTable } from '../components/Skeleton';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * "Hooks & Plugins" — config inventory of the device's `~/.claude/settings.json`
 * `hooks` and `enabledPlugins`, plus which `claude*` launch modes load them.
 *
 * Config view, not a live tracker: hooks are local shell commands with no Anthropic
 * API footprint, so the proxy can't observe firing — only what's declared. Verify
 * in-session with `/hooks`.
 */

/** Render a load-expectation state as a labelled badge. */
function LoadBadge({ state }: { state: AliasLoadExpectation['hooks'] | AliasLoadExpectation['plugins'] }) {
  const map = {
    native: { cls: 'absent', label: 'native' },
    'not-loaded': { cls: 'neutral', label: 'not loaded' },
    unverified: { cls: 'was-present', label: 'unverified' },
    expected: { cls: 'sev-info', label: 'expected' },
  } as const;
  const { cls, label } = map[state];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function HooksPluginsPage() {
  const query = useQuery({ queryKey: ['hooks-plugins'], queryFn: getHooksPlugins });
  const data = query.data;
  const hooks = data?.hooks ?? [];
  const plugins = data?.plugins ?? [];
  const loadExpectations = data?.loadExpectations ?? [];
  const anyUnverified = loadExpectations.some((e) => e.hooks === 'unverified' || e.plugins === 'expected');

  return (
    <section>
      <div className='pagehead'>
        <h1>Hooks &amp; Plugins</h1>
        <div className='muted'>
          What <span className='rule-name'>{data?.settingsPath ?? '~/.claude/settings.json'}</span> configures — and
          which launch modes are expected to load it.
        </div>
      </div>

      <div className='card' style={{ marginBottom: 16 }}>
        <div className='leak-note'>
          <strong>Configuration inventory, not a live tracker.</strong> Hooks are local shell commands Claude Code runs
          on your machine — they produce no API traffic, so the proxy can't confirm one actually <em>fired</em>, only
          what's declared here. To verify live firing, run <span className='rule-name'>/hooks</span> inside a session
          (and <span className='rule-name'>/plugin</span> for plugins).
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<HooksPluginsSkeleton />}>
        {!data?.settingsReadable ? (
          <div className='card empty'>
            Couldn't read device settings at <span className='rule-name'>{data?.settingsPath}</span>.
          </div>
        ) : (
          <>
            <div className='card' style={{ marginBottom: 16 }}>
              <div className='muted'>
                <strong>{hooks.length}</strong> hook command{hooks.length === 1 ? '' : 's'} configured.
              </div>
              {hooks.length === 0 ? (
                <div className='leak-note' style={{ marginTop: 8 }}>
                  No <span className='rule-name'>hooks</span> in <span className='rule-name'>{data.settingsPath}</span>.
                </div>
              ) : (
                <div className='table-scroll' style={{ marginTop: 12 }}>
                  <table className='table'>
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>Matcher</th>
                        <th>Command</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hooks.map((h, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: hooks are listed in configuration order, and the event alone is not unique
                        <tr key={`${h.event}-${i}`}>
                          <td className='rule-name'>{h.event}</td>
                          <td>
                            {h.matcher ? (
                              <span className='rule-name'>{h.matcher}</span>
                            ) : (
                              <span className='muted'>*</span>
                            )}
                          </td>
                          <td>
                            <span className='rule-name'>{h.command}</span>
                            {h.statusMessage && (
                              <div className='leak-note' style={{ marginTop: 4 }}>
                                {h.statusMessage}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className='card' style={{ marginBottom: 16 }}>
              <div className='muted'>
                <strong>{plugins.length}</strong> plugin{plugins.length === 1 ? '' : 's'} configured.
              </div>
              {plugins.length === 0 ? (
                <div className='leak-note' style={{ marginTop: 8 }}>
                  No <span className='rule-name'>enabledPlugins</span> in{' '}
                  <span className='rule-name'>{data.settingsPath}</span>.
                </div>
              ) : (
                <div className='table-scroll' style={{ marginTop: 12 }}>
                  <table className='table'>
                    <thead>
                      <tr>
                        <th>Plugin</th>
                        <th>Marketplace</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plugins.map((p) => (
                        <tr key={`${p.name}@${p.marketplace}`}>
                          <td className='rule-name'>{p.name}</td>
                          <td>
                            {p.marketplace ? (
                              <span className='rule-name'>{p.marketplace}</span>
                            ) : (
                              <span className='muted'>—</span>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${p.enabled ? 'absent' : 'neutral'}`}>
                              {p.enabled ? 'enabled' : 'disabled'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {loadExpectations.length > 0 && (
              <div className='card'>
                <div className='muted'>
                  <strong>Load expectations by launch mode</strong> — whether these user hooks/plugins load in each{' '}
                  <span className='rule-name'>claude*</span> alias, read from{' '}
                  <span className='rule-name'>{data.launchRcPath}</span>.
                </div>
                <div className='leak-note' style={{ marginTop: 8 }}>
                  <strong>native</strong> = loaded from the user settings source · <strong>not loaded</strong> = user
                  source dropped and nothing re-supplies them · <strong>unverified</strong> = settings injected via a
                  dynamic <span className='rule-name'>--settings</span>, and hooks-via-
                  <span className='rule-name'>--settings</span> is undocumented · <strong>expected</strong> =
                  dynamically injected and supported, but not confirmed here.
                  {anyUnverified && (
                    <>
                      {' '}
                      For anything below <strong>native</strong>, confirm with <span className='rule-name'>/hooks</span>{' '}
                      inside that session.
                    </>
                  )}
                </div>
                <div className='table-scroll' style={{ marginTop: 12 }}>
                  <table className='table'>
                    <thead>
                      <tr>
                        <th>Alias</th>
                        <th>Hooks</th>
                        <th>Plugins</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadExpectations.map((e) => (
                        <tr key={e.name}>
                          <td className='rule-name'>{e.name}</td>
                          <td>
                            <LoadBadge state={e.hooks} />
                          </td>
                          <td>
                            <LoadBadge state={e.plugins} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Every table on this page is three columns wide. */
const CONFIG_COLUMNS: readonly SkeletonColumn[] = [{ cell: '62%' }, { cell: '48%' }, {}];

/** The three inventory cards — hooks, plugins, and per-alias load expectations. */
function HooksPluginsSkeleton() {
  return (
    <>
      {[3, 2, 4].map((rows, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
        <div className='card' style={{ marginBottom: 16 }} key={i}>
          <div className='muted' aria-hidden>
            <Skeleton w='42%' />
          </div>
          {/* The real tables carry this offset themselves. */}
          <div style={{ marginTop: 12 }}>
            <SkeletonTable columns={CONFIG_COLUMNS} rows={rows} />
          </div>
        </div>
      ))}
    </>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hooks-plugins',
  component: HooksPluginsPage,
  staticData: { title: 'Hooks & Plugins' },
});

export const nav = {
  section: 'Device',
  to: '/hooks-plugins',
  label: 'Hooks & Plugins',
  hint: 'config',
  exact: false,
  icon: Puzzle,
} as const satisfies NavEntry;
