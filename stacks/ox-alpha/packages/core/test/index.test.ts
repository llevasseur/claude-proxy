import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from '../src/index.ts';

describe('CORE_PACKAGE', () => {
  it('names the core package', () => {
    expect(CORE_PACKAGE).toBe('@agent-proxy/ox-core');
  });
});
