import { sessionName, sessionPreview } from '@claude-proxy/core';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowUp, Check, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../api';
import { fmtAgeShort, fmtInt } from '../format';
import { useResolvedSessions } from '../useResolvedSessions';

/**
 * The session list, as a chat app's conversation rail: newest first, filterable,
 * and grown a page at a time as you scroll.
 *
 * The list arrives whole — `/api/sessions` has no cursor — so "infinite scroll" here
 * windows what is *rendered*.
 *
 * Active and Resolved each scroll on their own, split by a draggable divider.
 */
const PAGE = 30;

export function SessionsSidenav({
  sessions,
  activeId,
  isDrafting,
  onNewChat,
}: {
  sessions: SessionSummary[];
  /** Thread id of the transcript being read, if the reader is on one. */
  activeId?: string;
  /** True while the composer holds an unstarted chat. */
  isDrafting: boolean;
  onNewChat: () => void;
}) {
  const [filter, setFilter] = useState('');
  const { isResolved, activeAt, resolve, restore } = useResolvedSessions();
  const body = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useSplit();

  const matched = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) =>
      [sessionName(s), s.threadId, s.subtitle, s.firstTask, s.model].some((field) =>
        field?.toLowerCase().includes(needle),
      ),
    );
  }, [sessions, filter]);

  // Newest turn first in Active — and a session pulled back out of Resolved counts as newest.
  const active = useMemo(
    () => matched.filter((s) => !isResolved(s)).sort((a, b) => activeAt(b) - activeAt(a)),
    [matched, isResolved, activeAt],
  );
  const resolved = useMemo(
    () => matched.filter(isResolved).sort((a, b) => b.modified.localeCompare(a.modified)),
    [matched, isResolved],
  );

  // The top list takes a fixed height; the bottom one takes the rest.
  const onResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rail = body.current;
      const first = rail?.firstElementChild;
      const top = first instanceof HTMLElement ? first : null;
      if (!rail || !top) return;
      const startY = event.clientY;
      const startH = top.offsetHeight;
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => setSplit(clamp(startH + e.clientY - startY, rail.offsetHeight));
      const done = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
    },
    [setSplit],
  );

  const nudge = (by: number) => {
    const rail = body.current;
    const first = rail?.firstElementChild;
    if (rail && first instanceof HTMLElement) setSplit(clamp(first.offsetHeight + by, rail.offsetHeight));
  };

  return (
    <aside className='sessions-nav' aria-label='Sessions'>
      <div className='sessions-nav-body' ref={body}>
        <SessionSection
          title='Active'
          sessions={active}
          activeId={activeId}
          filter={filter}
          empty={sessions.length === 0 ? 'No session transcripts yet.' : 'Nothing active.'}
          onToggle={resolve}
          style={split === null ? undefined : { flex: 'none', height: `${split}px` }}
        />

        {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take the pointer and keyboard handlers that make this a drag handle */}
        <div
          className='sessions-nav-resize'
          role='separator'
          aria-orientation='horizontal'
          aria-valuenow={split ?? 0}
          aria-label='Resize the Active list'
          tabIndex={0}
          onPointerDown={onResize}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            nudge(e.key === 'ArrowUp' ? -24 : 24);
          }}
        />

        <SessionSection
          title='Resolved'
          sessions={resolved}
          activeId={activeId}
          filter={filter}
          resolved
          empty='Nothing resolved yet.'
          onToggle={restore}
          style={split === null ? { flex: '0 1 auto', maxHeight: '38%' } : undefined}
        />
      </div>

      <div className='sessions-nav-foot'>
        <div className='sessions-nav-actions'>
          <label className='sessions-search'>
            <Search size={14} strokeWidth={1.75} aria-hidden />
            <input
              type='search'
              value={filter}
              placeholder='Search sessions'
              aria-label='Search sessions'
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <button
            type='button'
            className={`sessions-new${isDrafting ? ' is-active' : ''}`}
            title='New chat'
            aria-label='New chat'
            onClick={onNewChat}>
            <Plus size={16} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <span className='muted sessions-nav-count'>
          {fmtInt(active.length)} active · {fmtInt(resolved.length)} resolved
          {filter.trim() ? ` of ${fmtInt(sessions.length)}` : ''}
        </span>
      </div>
    </aside>
  );
}

/** Keep both lists usable however the divider is dragged. */
const MIN_SECTION = 88;
function clamp(height: number, railHeight: number): number {
  return Math.max(MIN_SECTION, Math.min(height, railHeight - MIN_SECTION));
}

const SPLIT_KEY = 'admin:sessions-split';

/** Where the divider sits, in pixels of Active; `null` until the reader has dragged it. */
function useSplit(): [number | null, (next: number) => void] {
  const [split, setSplit] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(SPLIT_KEY);
      return raw ? Number(raw) || null : null;
    } catch {
      return null;
    }
  });

  const set = useCallback((next: number) => {
    setSplit(next);
    try {
      localStorage.setItem(SPLIT_KEY, String(Math.round(next)));
    } catch {
      /* ignore — the split stays session-only */
    }
  }, []);

  return [split, set];
}

/** One of the two lists: a sticky heading over its own scroller, paged by a sentinel at the end. */
function SessionSection({
  title,
  sessions,
  activeId,
  filter,
  resolved = false,
  empty,
  onToggle,
  style,
}: {
  title: string;
  sessions: SessionSummary[];
  activeId?: string;
  /** Narrowing the list starts it over at the top, at the first page. */
  filter: string;
  resolved?: boolean;
  empty: string;
  onToggle: (threadId: string) => void;
  style?: React.CSSProperties;
}) {
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed filter is exactly what should reset the page and scroll position
  useEffect(() => {
    setShown(PAGE);
    if (list.current) list.current.scrollTop = 0;
  }, [filter]);

  const visible = sessions.slice(0, shown);
  const more = shown < sessions.length;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
      },
      // Reach for the next page before the reader hits the end of this one.
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  return (
    <section className='sessions-group' style={style}>
      <h2 className='sessions-group-head'>
        {title}
        <span className='sessions-group-count'>{fmtInt(sessions.length)}</span>
      </h2>
      <div className='sessions-nav-list' ref={list}>
        {sessions.length === 0 ? (
          <p className='muted sessions-nav-empty'>{empty}</p>
        ) : (
          <>
            {visible.map((s) => (
              <SessionRow
                key={s.threadId}
                session={s}
                active={s.threadId === activeId}
                resolved={resolved}
                onToggle={onToggle}
              />
            ))}
            {more && (
              <div ref={sentinel} className='muted sessions-nav-more'>
                Loading more…
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A card in the rail, with the file-away control the row reveals on hover.
 *
 * The control is a sibling of the link, not a child: a button inside an anchor is invalid.
 */
function SessionRow({
  session,
  active,
  resolved,
  onToggle,
}: {
  session: SessionSummary;
  active: boolean;
  resolved: boolean;
  onToggle: (threadId: string) => void;
}) {
  const name = sessionName(session);
  // Not the raw prompt — a slash-command session's opens with `<command-message>`, which
  // clamped to two lines reads as XML broken mid-tag. The clamp on `.session-row-preview`
  // is the second cut rather than the only one.
  const preview = sessionPreview(session);
  const label = resolved ? 'Move back to Active' : 'Resolve';
  return (
    <div className={`session-row${active ? ' is-active' : ''}`}>
      <Link to='/sessions/$id' params={{ id: session.threadId }} className='session-row-link'>
        <div className='session-row-top'>
          <span className='session-row-name'>{name ?? session.threadId}</span>
          <span className='session-row-age'>{fmtAgeShort(session.modified)}</span>
        </div>
        {preview && <span className='session-row-preview'>{preview}</span>}
        <div className='session-row-meta'>
          {session.model && <span className='session-chip'>{session.model}</span>}
          {session.tools > 0 && <span className='session-chip'>{fmtInt(session.tools)} tools</span>}
          {session.errors > 0 && (
            <span className='session-chip is-bad'>
              <AlertTriangle size={11} strokeWidth={2} aria-hidden />
              {fmtInt(session.errors)}
            </span>
          )}
        </div>
      </Link>
      <button
        type='button'
        className='session-row-cta'
        title={label}
        aria-label={`${label}: ${name ?? session.threadId}`}
        onClick={() => onToggle(session.threadId)}>
        {resolved ? <ArrowUp size={14} strokeWidth={2} aria-hidden /> : <Check size={14} strokeWidth={2} aria-hidden />}
      </button>
    </div>
  );
}
