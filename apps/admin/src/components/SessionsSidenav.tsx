import { sessionName } from "@claude-proxy/core";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, PenSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../api";
import { fmtAgeShort, fmtInt } from "../format";

/**
 * The session list, as a chat app's conversation rail: newest first, filterable,
 * and grown a page at a time as you scroll.
 *
 * The list arrives whole — `/api/sessions` has no cursor — so "infinite scroll" here
 * windows what is *rendered*.
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
  /** True while the composer holds an unstarted chat — the "New chat" row is the active one. */
  isDrafting: boolean;
  onNewChat: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const matched = useMemo(() => {
    const rows = [...sessions].sort((a, b) => b.modified.localeCompare(a.modified));
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((s) =>
      [sessionName(s), s.threadId, s.subtitle, s.firstTask, s.model].some((field) =>
        field?.toLowerCase().includes(needle),
      ),
    );
  }, [sessions, filter]);

  // A narrowed list starts at the top again, at the first page.
  useEffect(() => {
    setShown(PAGE);
    if (list.current) list.current.scrollTop = 0;
  }, [filter]);

  const visible = matched.slice(0, shown);
  const more = shown < matched.length;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
      },
      // Reach for the next page before the reader hits the end of this one.
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  return (
    <aside className="sessions-nav" aria-label="Sessions">
      <div className="sessions-nav-head">
        <button
          type="button"
          className={`sessions-new${isDrafting ? " is-active" : ""}`}
          onClick={onNewChat}
        >
          <PenSquare size={15} strokeWidth={1.75} aria-hidden />
          New chat
        </button>
        <label className="sessions-search">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            value={filter}
            placeholder="Search sessions"
            aria-label="Search sessions"
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
      </div>

      <div className="sessions-nav-list" ref={list}>
        {matched.length === 0 ? (
          <p className="muted sessions-nav-empty">
            {sessions.length === 0 ? "No session transcripts yet." : "No session matches that."}
          </p>
        ) : (
          <>
            {visible.map((s) => (
              <SessionRow key={s.threadId} session={s} active={s.threadId === activeId} />
            ))}
            {more && (
              <div ref={sentinel} className="muted sessions-nav-more">
                Loading more…
              </div>
            )}
          </>
        )}
      </div>

      <div className="sessions-nav-foot muted">
        {fmtInt(matched.length)}
        {filter.trim() ? ` of ${fmtInt(sessions.length)}` : ""} session
        {matched.length === 1 && !filter.trim() ? "" : "s"}
      </div>
    </aside>
  );
}

function SessionRow({ session, active }: { session: SessionSummary; active: boolean }) {
  const name = sessionName(session);
  const preview = session.subtitle ?? session.firstTask;
  return (
    <Link
      to="/sessions/$id"
      params={{ id: session.threadId }}
      className={`session-row${active ? " is-active" : ""}`}
    >
      <div className="session-row-top">
        <span className="session-row-name">{name ?? session.threadId}</span>
        <span className="session-row-age">{fmtAgeShort(session.modified)}</span>
      </div>
      {preview && preview !== name && <span className="session-row-preview">{preview}</span>}
      <div className="session-row-meta">
        {session.model && <span className="session-chip">{session.model}</span>}
        {session.tools > 0 && <span className="session-chip">{fmtInt(session.tools)} tools</span>}
        {session.errors > 0 && (
          <span className="session-chip is-bad">
            <AlertTriangle size={11} strokeWidth={2} aria-hidden />
            {fmtInt(session.errors)}
          </span>
        )}
      </div>
    </Link>
  );
}
