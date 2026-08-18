import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ChatSendResponse, PermissionMode } from './api';
import { endChat, getChatThread, sendChatMessage, startChat, stopChat } from './api';
import { type LiveTurn, useChatStream } from './useChatStream';

/** The one dashboard-started chat, held above the router so it outlives the page it was typed on. */
export interface ChatSessionValue {
  /** Named before the first turn: the CLI `--session-id`, Stop's handle, and the URL a fresh chat lands on. */
  sessionId: string;
  /** The last completed turn's result — history, usage, tools, interruption. */
  chat: ChatSendResponse | null;
  /** The prompt in flight; shown as a turn before the reply lands. */
  pendingPrompt: string | null;
  /**
   * The turn in flight as it happens — the reply's text so far and the tools it has run.
   * Empty between turns, and always superseded by `chat` when the turn resolves.
   */
  live: LiveTurn;
  /** The unsent input, held here so navigating away doesn't discard it. */
  draft: string;
  setDraft: (next: string) => void;
  isSending: boolean;
  sendError: Error | null;
  isStopping: boolean;
  stopError: Error | null;
  /** Picked before the first turn; pinned server-side once the session starts. */
  permissionMode: PermissionMode | null;
  setPermissionMode: (permission: PermissionMode) => void;
  /** Starts the session on the first call, continues it after. */
  send: (prompt: string) => void;
  stop: () => void;
  /** Opens a fresh id, ending the server's copy of the old one. */
  reset: () => void;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [chat, setChat] = useState<ChatSendResponse | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // null → follow whatever the server defaults to.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);

  const sendMutation = useMutation({
    mutationFn: (prompt: string) =>
      chat
        ? sendChatMessage(sessionId, prompt)
        : startChat(sessionId, prompt, { mode: 'agent', permissionMode: permissionMode ?? undefined }),
    onSuccess: (data) => {
      setChat(data);
      // The transcript is new, or it grew.
      client.invalidateQueries({ queryKey: ['sessions'] });
    },
    // The turn's history carries this prompt now; a failure carries the error.
    onSettled: () => setPendingPrompt(null),
  });

  // Stopping doesn't fail the send: the turn resolves with whatever it had reached.
  const stopMutation = useMutation({ mutationFn: () => stopChat(sessionId) });

  // Watched for exactly as long as a prompt is in flight, and held here rather than in the
  // chat pane so a streaming turn survives navigating away from it, as the turn log does.
  const live = useChatStream(sessionId, pendingPrompt !== null);

  const send = useCallback(
    (prompt: string) => {
      setPendingPrompt(prompt);
      // Cleared on submit, not on success: the prompt is already on screen as a turn.
      setDraft('');
      sendMutation.mutate(prompt);
    },
    [sendMutation],
  );

  const stop = useCallback(() => stopMutation.mutate(), [stopMutation]);

  const reset = useCallback(() => {
    endChat(sessionId).catch(() => {
      /* best-effort: a session it has already forgotten is the outcome we wanted */
    });
    setSessionId(crypto.randomUUID());
    setChat(null);
    setPendingPrompt(null);
    setDraft('');
    // Both mutations too, or a failed turn's error sits under the new empty chat.
    sendMutation.reset();
    stopMutation.reset();
  }, [sessionId, sendMutation, stopMutation]);

  const value = useMemo<ChatSessionValue>(
    () => ({
      sessionId,
      chat,
      pendingPrompt,
      live,
      draft,
      setDraft,
      isSending: sendMutation.isPending,
      sendError: sendMutation.error,
      isStopping: stopMutation.isPending,
      stopError: stopMutation.error,
      permissionMode,
      setPermissionMode,
      send,
      stop,
      reset,
    }),
    [
      sessionId,
      chat,
      pendingPrompt,
      live,
      draft,
      sendMutation.isPending,
      sendMutation.error,
      stopMutation.isPending,
      stopMutation.error,
      permissionMode,
      send,
      stop,
      reset,
    ],
  );

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error('useChatSession must be used inside a ChatSessionProvider');
  return value;
}

/** How often to re-ask which transcript a just-started chat became. */
const THREAD_POLL_MS = 2_000;
/**
 * How long to keep asking. The transcript appears within seconds of the first request — well
 * inside this — so past it the session is one that never started, or an id that was never ours.
 */
const THREAD_POLL_CEILING_MS = 120_000;

/** The transcript behind a chat session, and whether the search has been abandoned. */
export interface ChatThreadLookup {
  /** The proxy's thread id once it exists, `null` while the poll is still looking. */
  threadId: string | null;
  /** True once the poll gave up, so the caller stops promising a transcript is coming. */
  gaveUp: boolean;
}

/**
 * The transcript a chat session id became, asked for until the proxy has written it. Lands within
 * seconds of the first request, so it resolves mid-turn rather than when the turn finishes.
 */
export function useChatThread(sessionId: string, enabled: boolean): ChatThreadLookup {
  const [gaveUp, setGaveUp] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session id must restart the give-up clock, which is why it is listed even though the effect body never reads it
  useEffect(() => {
    setGaveUp(false);
    if (!enabled) return;
    const timer = setTimeout(() => setGaveUp(true), THREAD_POLL_CEILING_MS);
    return () => clearTimeout(timer);
  }, [sessionId, enabled]);

  const query = useQuery({
    queryKey: ['chat', 'thread', sessionId],
    queryFn: () => getChatThread(sessionId),
    enabled: enabled && !gaveUp,
    // A thread id never changes once the proxy has answered, so stop asking.
    refetchInterval: (q) => (q.state.data?.threadId ? false : THREAD_POLL_MS),
  });

  return { threadId: query.data?.threadId ?? null, gaveUp };
}
