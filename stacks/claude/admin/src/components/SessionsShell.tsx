import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { SessionSummary } from '../api';
import { QueryState } from './QueryState';
import { SessionsSidenav } from './SessionsSidenav';
import { Skeleton } from './Skeleton';

const tabIdle = {
  color: 'var(--muted)',
  textDecoration: 'none',
  transition: 'color var(--motion-duration) var(--ease-out)',
} as const;

const tabActive = {
  ...tabIdle,
  color: 'var(--text)',
  fontWeight: 600,
} as const;

/**
 * The frame every sessions view shares (ADR 0028): a slim view switch — Chat and the
 * coming Alive view — above the rail-and-pane grid, with the transcript rail on the
 * left under its loading/error framing and the caller's pane beside it.
 */
export function SessionsShell({
  isLoading,
  error,
  busy,
  sessions,
  activeId,
  isDrafting,
  onNewChat,
  onSelect,
  children,
}: {
  /** The sessions query's state, framing the rail while it loads or fails. */
  isLoading: boolean;
  error: unknown;
  /** True while a refetch supersedes what is already on screen. */
  busy?: boolean;
  sessions: SessionSummary[];
  activeId?: string;
  isDrafting: boolean;
  onNewChat: () => void;
  /** Row activation in place of navigation; absent, rows link to the transcript page. */
  onSelect?: (threadId: string) => void;
  /** The pane beside the rail — the chat today, the alive view once its route lands. */
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <section style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <nav
        aria-label='Session views'
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-7)',
          padding: 'var(--space-5) var(--space-9)',
          borderBottom: '1px solid var(--line)',
          background: 'var(--surface)',
        }}>
        <Link
          to='/sessions'
          style={pathname === '/sessions' ? tabActive : tabIdle}
          aria-current={pathname === '/sessions' ? 'page' : undefined}>
          Chat
        </Link>
        <Link to='/sessions/alive' style={pathname === '/sessions/alive' ? tabActive : tabIdle}>
          Alive
        </Link>
      </nav>

      {/* The grid below is the shell the sessions pages have always had; only the
          switch row above it is new. */}
      <section className='sessions-shell' style={{ height: 'auto', flex: 1, minHeight: 0 }}>
        <QueryState isLoading={isLoading} error={error} skeleton={<SessionsRailSkeleton />} busy={busy}>
          <SessionsSidenav
            sessions={sessions}
            activeId={activeId}
            isDrafting={isDrafting}
            onNewChat={onNewChat}
            onSelect={onSelect}
          />
        </QueryState>
        <div className='sessions-main'>{children}</div>
      </section>
    </section>
  );
}

/** The transcript rail, shaped like the rows `SessionsSidenav` fills it with. */
function SessionsRailSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <aside className='sessions-nav' aria-hidden>
      <div className='sessions-nav-body'>
        <div className='sessions-nav-list'>
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
            <div className='session-row-link' key={i}>
              <div className='session-row-top'>
                <span className='session-row-name'>
                  <Skeleton w={`${72 - (i % 3) * 12}%`} />
                </span>
                <span className='session-row-age'>
                  <Skeleton w='2.5rem' />
                </span>
              </div>
              <span className='session-row-preview'>
                <Skeleton w='88%' />
              </span>
              <div className='session-row-meta'>
                <Skeleton w='4rem' />
                <Skeleton w='3.5rem' />
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
