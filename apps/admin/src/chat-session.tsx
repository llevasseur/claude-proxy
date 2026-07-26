import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ChatMode, ChatSendResponse, PermissionMode } from "./api";
import { endChat, sendChatMessage, startChat, stopChat } from "./api";

/** The one dashboard-started chat, held above the router so it outlives the page it was typed on. */
export interface ChatSessionValue {
  /** Named before the first turn: the CLI `--session-id`, Stop's handle, and the URL a fresh chat lands on. */
  sessionId: string;
  /** The last completed turn's result — history, usage, tools, interruption. */
  chat: ChatSendResponse | null;
  /** The prompt in flight; shown as a turn before the reply lands. */
  pendingPrompt: string | null;
  isSending: boolean;
  sendError: Error | null;
  isStopping: boolean;
  stopError: Error | null;
  /** Picked before the first turn; both are pinned server-side once the session starts. */
  mode: ChatMode | null;
  permissionMode: PermissionMode | null;
  setMode: (mode: ChatMode) => void;
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
  // null → follow whatever the server defaults to.
  const [mode, setMode] = useState<ChatMode | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);

  const sendMutation = useMutation({
    mutationFn: (prompt: string) =>
      chat
        ? sendChatMessage(sessionId, prompt)
        : startChat(sessionId, prompt, { mode: mode ?? undefined, permissionMode: permissionMode ?? undefined }),
    onSuccess: (data) => {
      setChat(data);
      // The transcript is new, or it grew.
      client.invalidateQueries({ queryKey: ["sessions"] });
    },
    // The turn's history carries this prompt now; a failure carries the error.
    onSettled: () => setPendingPrompt(null),
  });

  // Stopping doesn't fail the send: the turn resolves with whatever it had reached.
  const stopMutation = useMutation({ mutationFn: () => stopChat(sessionId) });

  const send = useCallback(
    (prompt: string) => {
      setPendingPrompt(prompt);
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
    // Both mutations too, or a failed turn's error sits under the new empty chat.
    sendMutation.reset();
    stopMutation.reset();
  }, [sessionId, sendMutation, stopMutation]);

  const value = useMemo<ChatSessionValue>(
    () => ({
      sessionId,
      chat,
      pendingPrompt,
      isSending: sendMutation.isPending,
      sendError: (sendMutation.error as Error | null) ?? null,
      isStopping: stopMutation.isPending,
      stopError: (stopMutation.error as Error | null) ?? null,
      mode,
      permissionMode,
      setMode,
      setPermissionMode,
      send,
      stop,
      reset,
    }),
    [
      sessionId,
      chat,
      pendingPrompt,
      sendMutation.isPending,
      sendMutation.error,
      stopMutation.isPending,
      stopMutation.error,
      mode,
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
  if (!value) throw new Error("useChatSession must be used inside a ChatSessionProvider");
  return value;
}
