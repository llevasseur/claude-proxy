// Is a captured session still running right now?
//
// The verdict is *derived*, never reported (`packages/core/src/liveness.ts`
// at the pinned commit), adapted to OpenAI Responses captures: the two facts
// are when the session was last captured, and whether its newest response
// carries a terminal Responses event. Pure, with `now` passed in.

export type LivenessState = 'running' | 'quiet' | 'finished' | 'unknown';

/**
 * How long a session may go without a new capture before it reads `quiet`
 * rather than `running`. Ten minutes: one long tool call appends nothing for
 * as long as it runs.
 */
export const QUIET_AFTER_MS = 10 * 60_000;

export interface SessionLiveness {
  readonly state: LivenessState;
  /** Newest observed activity, ISO 8601; null when undated. */
  readonly lastActivity: string | null;
  /** Milliseconds since lastActivity at the moment of the read; null when undated. */
  readonly idleMs: number | null;
  /** The threshold this verdict was taken against — stated, so a reader can disagree. */
  readonly quietAfterMs: number;
  /** True when a terminal response event was found, which is what makes a session `finished`. */
  readonly terminal: boolean;
}

/**
 * Classify one session. `lastActivity` is the newest capture timestamp;
 * `terminal` whether the newest captured response ended the exchange
 * (a `response.completed` event or a final JSON document).
 */
export function classifyLiveness(
  lastActivity: string | null,
  terminal: boolean,
  now: Date,
  quietAfterMs = QUIET_AFTER_MS,
): SessionLiveness {
  const at = lastActivity === null ? Number.NaN : Date.parse(lastActivity);
  if (Number.isNaN(at)) {
    return Object.freeze({
      state: 'unknown',
      lastActivity,
      idleMs: null,
      quietAfterMs,
      terminal,
    });
  }
  const idleMs = Math.max(0, now.getTime() - at);
  const state: LivenessState = terminal ? 'finished' : idleMs <= quietAfterMs ? 'running' : 'quiet';
  return Object.freeze({
    state,
    lastActivity,
    idleMs,
    quietAfterMs,
    terminal,
  });
}
