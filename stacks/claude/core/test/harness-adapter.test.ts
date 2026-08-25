import { describe, expect, it } from 'vitest';
import { HARNESS_IDS } from '../src/adapter-seam.js';
import {
  claudeCodeHarnessAdapter,
  codexHarnessAdapter,
  createHarnessRegistry,
  harnessRegistry,
  opencodeHarnessAdapter,
} from '../src/harness-adapter.js';

describe('harness capabilities gate rather than delete', () => {
  it('declares what Claude Code is known to support', () => {
    expect(claudeCodeHarnessAdapter.supports('session-transcripts')).toBe(true);
    expect(claudeCodeHarnessAdapter.supports('system-prompt-capture')).toBe(true);
    expect(claudeCodeHarnessAdapter.supports('skim-cache')).toBe(true);
  });

  it('answers false for a harness whose capabilities are not established', () => {
    // Empty means "not yet established", never "known absent" — and it gates the
    // surface off, which is the safe direction.
    expect(codexHarnessAdapter.supports('session-transcripts')).toBe(false);
    expect(opencodeHarnessAdapter.supports('skim-cache')).toBe(false);
    expect(codexHarnessAdapter.capabilities).toEqual([]);
    expect(opencodeHarnessAdapter.capabilities).toEqual([]);
  });

  it('does not let a caller widen a declared capability set', () => {
    expect(Object.isFrozen(claudeCodeHarnessAdapter.capabilities)).toBe(true);
  });
});

describe('the harness registry', () => {
  it('ships the three harnesses and nothing else', () => {
    expect([...harnessRegistry.ids()].sort()).toEqual([...HARNESS_IDS].sort());
  });

  it('returns the adapter registered for each harness', () => {
    expect(harnessRegistry.get('claude-code')).toBe(claudeCodeHarnessAdapter);
    expect(harnessRegistry.get('codex')).toBe(codexHarnessAdapter);
    expect(harnessRegistry.get('opencode')).toBe(opencodeHarnessAdapter);
  });

  it('throws rather than guessing for an unregistered harness', () => {
    const empty = createHarnessRegistry();
    expect(() => empty.get('codex')).toThrow(/no harness adapter registered/);
    expect(empty.find('codex')).toBeUndefined();
  });
});
