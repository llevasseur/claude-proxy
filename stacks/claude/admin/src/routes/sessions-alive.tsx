import type { FamilyTranscript } from '@agent-proxy/claude-core';
import { deriveAliveView } from '@agent-proxy/claude-core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { getSessionGraphNodes, getSessionsGraph } from '../api';
import { useChatSession, useChatThread } from '../chat-session';
import { SessionsShell } from '../components/SessionsShell';
import { rootRoute } from '../route-root';

/**
 * The Alive View — one emotion word and one trigger line for the watched agent
 * family (docs/features/alive-view.md; ADRs 0018–0028). Text only: the reading
 * derives from ticket 02's pure core over the same server-built node streams the
 * live session graph polls, at that graph's cadence. No SSE: the index poll
 * refreshes `modified` every 4 s against a 30-minute stress threshold, so a
 * stream would be decoration (ADR 0018's redundancy clause).
 *
 * No `nav` export — the page lives under Sessions, reached through the shell's
 * Alive tab rather than the side rail.
 */

/** The thin index poll — shared key and cadence with `session-graph.tsx`. */
const INDEX_REFETCH_MS = 4_000;

/** Backstop re-read of the family's node streams; step-count changes refetch sooner. */
const NODES_REFETCH_MS = 20_000;

/** Re-render cadence for relative ages, well inside their displayed minute. */
const NOW_TICK_MS = 15_000;

export function SessionsAlivePage() {
  const query = useQuery({
    queryKey: ['sessions-graph'],
    queryFn: getSessionsGraph,
    refetchInterval: INDEX_REFETCH_MS,
  });
  const transcripts = useMemo(() => query.data?.sessions ?? [], [query.data]);
  const byThread = useMemo(() => new Map(transcripts.map((s) => [s.threadId, s])), [transcripts]);

  // The watched id: whatever the rail picked, else the thread this tab owns.
  // The owned thread resolves asynchronously after a turn starts, so it is the
  // default watch rather than a state initialiser — the pick wins once made.
  const { sessionId, chat, pendingPrompt } = useChatSession();
  const started = chat !== null || pendingPrompt !== null;
  const { threadId: resolved } = useChatThread(sessionId, started && !chat?.session.threadId);
  const owned = chat?.session.threadId ?? resolved ?? undefined;
  const [pickedId, setPickedId] = useState<string | null>(null);
  const watchedId = pickedId ?? owned ?? null;

  /** Walk up to the top-level session a transcript belongs to — what the family describes. */
  const rootOf = useMemo(() => {
    const cache = new Map<string, string>();
    return (id: string): string => {
      let at = id;
      const path: string[] = [];
      while (!cache.has(at)) {
        path.push(at);
        const parent = byThread.get(at)?.parentThreadId;
        if (!parent || !byThread.has(parent)) break;
        at = parent;
      }
      const root = cache.get(at) ?? at;
      for (const step of path) cache.set(step, root);
      return root;
    };
  }, [byThread]);

  // The watched family's members with the facts the derivation needs off the
  // index rows: the last-append clock (`modified`, ADR 0019) and the step count
  // fingerprinted into the nodes query key.
  const familyMembers = useMemo(() => {
    if (watchedId === null || byThread.size === 0) return [];
    const members: { threadId: string; modified: string; steps: number }[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => {
      const row = byThread.get(id);
      if (!row || seen.has(id)) return;
      seen.add(id);
      members.push({ threadId: id, modified: row.modified, steps: row.steps });
      for (const kid of row.childThreadIds) walk(kid);
    };
    walk(rootOf(watchedId));
    return members;
  }, [watchedId, byThread, rootOf]);

  const rootId = familyMembers[0]?.threadId ?? null;
  const familySteps = useMemo(() => familyMembers.map((m) => `${m.threadId}:${m.steps}`).join(','), [familyMembers]);

  // The family's node streams, polled exactly as `session-graph.tsx` does. Silent
  // failure: an unreadable stream leaves the previous reading on screen.
  const nodesQuery = useQuery({
    queryKey: ['session-graph-nodes', rootId, familySteps],
    queryFn: () => getSessionGraphNodes(rootId!),
    enabled: rootId !== null,
    refetchInterval: NODES_REFETCH_MS,
    placeholderData: keepPreviousData,
  });

  // Each member enters the derivation as its raw transcript/derived pair — the
  // shape this endpoint already returns; the core merges (ticket 02).
  const family = useMemo<FamilyTranscript[]>(() => {
    const data = nodesQuery.data;
    if (!data) return [];
    const transcriptNodes = new Map(data.transcripts.map((t) => [t.threadId, t.nodes]));
    const derivedNodes = new Map(data.threads.map((t) => [t.threadId, t.nodes]));
    return familyMembers.map((m) => ({
      threadId: m.threadId,
      modified: m.modified,
      transcript: transcriptNodes.get(m.threadId),
      derived: derivedNodes.get(m.threadId),
    }));
  }, [nodesQuery.data, familyMembers]);

  // The clock is injected at render, not read inside the core.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const view = deriveAliveView(family, now);
  const empty = watchedId === null;

  return (
    <SessionsShell
      isLoading={query.isLoading}
      error={query.error}
      sessions={transcripts}
      activeId={watchedId ?? undefined}
      isDrafting={false}
      onSelect={setPickedId}>
      <section
        aria-label='Alive'
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-7)',
          padding: 'var(--space-12)',
        }}>
        <span
          aria-live='polite'
          style={{
            fontSize: 'var(--text-10)',
            fontWeight: 600,
            color: 'var(--text)',
            transition: 'color var(--motion-duration) var(--ease-out)',
          }}>
          {empty ? 'Smiling' : view.emotion}
        </span>
        {/* Outside the live region on purpose (ADR 0027): the line churns per append. */}
        <span className='muted' style={{ fontSize: 'var(--text-5)' }}>
          {empty ? 'nothing active · select a session in the rail' : view.trigger}
        </span>
      </section>
    </SessionsShell>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/alive',
  component: SessionsAlivePage,
  staticData: { title: 'Alive' },
});
