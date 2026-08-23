import { describe, expect, test } from 'vitest';
import { classifyLiveness, QUIET_AFTER_MS } from '../src/liveness.ts';

const NOW = new Date('2026-08-20T18:00:00.000Z');

describe('session liveness', () => {
  test('a terminal response finishes a session regardless of recency', () => {
    const verdict = classifyLiveness('2026-08-20T17:59:00.000Z', true, NOW);
    expect(verdict.state).toBe('finished');
    expect(verdict.terminal).toBe(true);
    expect(verdict.idleMs).toBe(60_000);
    expect(verdict.quietAfterMs).toBe(QUIET_AFTER_MS);
  });

  test('recent non-terminal activity reads running, then quiet after the threshold', () => {
    expect(classifyLiveness('2026-08-20T17:55:00.000Z', false, NOW).state).toBe('running');
    expect(classifyLiveness('2026-08-20T17:00:00.000Z', false, NOW).state).toBe('quiet');
    // Exactly at the threshold it is still running.
    expect(classifyLiveness('2026-08-20T17:50:00.000Z', false, NOW).state).toBe('running');
  });

  test('an undated session reads unknown rather than guessing', () => {
    const verdict = classifyLiveness(null, false, NOW);
    expect(verdict.state).toBe('unknown');
    expect(verdict.idleMs).toBeNull();
  });
});
