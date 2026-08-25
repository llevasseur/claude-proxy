import { describe, expect, test } from 'vitest';
import { resolveServerPort } from '../src/config.js';

describe('the listener port', () => {
  // ADR 0050: one root `.env` would bind a bare `PORT` to this stack's proxy too. The legacy
  // name keeps working for this package alone.
  test('the scoped name wins over the legacy bare name', () => {
    expect(resolveServerPort({ CLAUDE_SERVER_PORT: '9401', PORT: '9402' })).toBe(9401);
  });

  test('the legacy bare name still resolves when the scoped name is absent', () => {
    expect(resolveServerPort({ PORT: '9403' })).toBe(9403);
  });

  test('the default is the unchanged 8788', () => {
    expect(resolveServerPort({})).toBe(8788);
  });
});
