import { describe, expect, it } from 'vitest';
import {
  classifyAgents,
  DEFAULT_AGENT_PATTERNS,
  filterInterfaces,
  matchesInterfacePattern,
  stripPidSuffix,
} from '../src/model.ts';

describe('stripPidSuffix (decision internet-spend 004)', () => {
  it('strips nettop trailing .pid suffixes', () => {
    expect(stripPidSuffix('launchd.1')).toBe('launchd');
    expect(stripPidSuffix('com.apple.WebKit.Networking.4821')).toBe('com.apple.WebKit.Networking');
  });

  it('leaves names without a numeric suffix alone', () => {
    expect(stripPidSuffix('Claude Helper (Renderer)')).toBe('Claude Helper (Renderer)');
    expect(stripPidSuffix('node')).toBe('node');
  });
});

describe('classifyAgents (decision internet-spend 004)', () => {
  it('matches case-insensitively by substring', () => {
    expect(classifyAgents('Claude', ['claude'])).toBe(true);
    expect(classifyAgents('claude code cli', ['CLAUDE'])).toBe(true);
    expect(classifyAgents('Safari', ['claude'])).toBe(false);
  });

  it('catches Electron helper names with no extra entries', () => {
    expect(classifyAgents('Claude Helper (Renderer)', DEFAULT_AGENT_PATTERNS)).toBe(true);
    expect(classifyAgents('Codex Helper (GPU).912', DEFAULT_AGENT_PATTERNS)).toBe(true);
  });

  it('classifies after .pid stripping', () => {
    expect(classifyAgents('node.4413', ['node'])).toBe(true);
    expect(classifyAgents('ox-alpha.77', ['ox'])).toBe(true);
  });

  it('matches nothing without patterns', () => {
    expect(classifyAgents('node.1', [])).toBe(false);
  });
});

describe('filterInterfaces (decision internet-spend 001)', () => {
  const rows = [
    { interface: 'en0', bytes: 100 },
    { interface: 'en5', bytes: 10 },
    { interface: 'lo0', bytes: 5_000 },
    { interface: 'utun3', bytes: 400 },
    { interface: 'awdl0', bytes: 7 },
  ];

  it('defaults to the wire-byte en* filter', () => {
    expect(filterInterfaces(rows)).toEqual([
      { interface: 'en0', bytes: 100 },
      { interface: 'en5', bytes: 10 },
    ]);
  });

  it('re-slices history under a changed policy at read time', () => {
    expect(filterInterfaces(rows, 'utun*')).toEqual([{ interface: 'utun3', bytes: 400 }]);
  });

  it('treats * as a wildcard and everything else literally', () => {
    expect(matchesInterfacePattern('en0', 'en*')).toBe(true);
    expect(matchesInterfacePattern('awdl0', 'en*')).toBe(false);
    expect(matchesInterfacePattern('bridge0', 'bridge0')).toBe(true);
  });
});
