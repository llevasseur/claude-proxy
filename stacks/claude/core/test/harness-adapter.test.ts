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

/** The five members added so the device-and-request gates name their own state. */
const DEVICE_MEMBERS = [
  'device-settings-file',
  'user-defined-commands',
  'project-scoped-memory',
  'installed-cli-bundle',
  'harness-injected-request-content',
] as const;

describe('the widened union', () => {
  it('declares every added member for Claude Code, on evidence this repository reads', () => {
    for (const member of DEVICE_MEMBERS) {
      expect(claudeCodeHarnessAdapter.supports(member)).toBe(true);
    }
  });

  it('answers false for the harnesses that have established nothing', () => {
    for (const member of DEVICE_MEMBERS) {
      expect(codexHarnessAdapter.supports(member)).toBe(false);
      expect(opencodeHarnessAdapter.supports(member)).toBe(false);
    }
  });

  it('stays closed, so an unknown member is a type error rather than a silent false', () => {
    // @ts-expect-error A free-form string is not a `HarnessCapability`. A gate keyed
    // on one fails *open* on a typo — this misspelling is the failure ticket 01
    // closed the union against, and widening it must not have relaxed that.
    expect(claudeCodeHarnessAdapter.supports('device-setings-file')).toBe(false);
  });

  it('names no provider in any member, keeping the two axes independent per ADR 0040', () => {
    for (const member of claudeCodeHarnessAdapter.capabilities) {
      expect(member).not.toMatch(/anthropic|openai|ox-alpha|claude|codex|opencode/);
    }
  });
});
