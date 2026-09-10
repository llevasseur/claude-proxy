import { describe, expect, it } from 'vitest';
import { HARNESS_IDS, PROVIDER_IDS } from '../src/adapter-seam.js';
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  type CapabilityId,
  capabilitiesFor,
  capabilityAllowsHarness,
  capabilityAllowsProvider,
  capabilityDeclaration,
  harnessSupports,
  isCapabilityAvailable,
  providerSupports,
} from '../src/capabilities.js';

/** The pair every gated capability in this repository was written against. */
const CLAUDE_SESSION = { provider: 'anthropic', harness: 'claude-code' } as const;

describe('a gated capability renders for its own pair', () => {
  it('renders the Anthropic-wire-specific ones for an Anthropic session', () => {
    expect(isCapabilityAvailable('subscription-usage-windows', CLAUDE_SESSION)).toBe(true);
    expect(isCapabilityAvailable('live-usage-poll', CLAUDE_SESSION)).toBe(true);
    expect(isCapabilityAvailable('additive-cache-accounting', CLAUDE_SESSION)).toBe(true);
  });

  it('renders the Claude-Code-specific ones for a Claude Code session', () => {
    expect(isCapabilityAvailable('session-transcripts', CLAUDE_SESSION)).toBe(true);
    expect(isCapabilityAvailable('skim-response-cache', CLAUDE_SESSION)).toBe(true);
    expect(isCapabilityAvailable('device-system-prompt', CLAUDE_SESSION)).toBe(true);
  });

  it('renders the ones that are genuinely both', () => {
    expect(isCapabilityAvailable('wire-system-prompt-outline', CLAUDE_SESSION)).toBe(true);
    expect(isCapabilityAvailable('prompt-cache-breakpoint-repair', CLAUDE_SESSION)).toBe(true);
  });
});

describe('the same capability answers false for the other two providers', () => {
  it('closes an Anthropic-wire-specific gate for openai and ox-alpha', () => {
    expect(capabilityAllowsProvider('subscription-usage-windows', 'openai')).toBe(false);
    expect(capabilityAllowsProvider('subscription-usage-windows', 'ox-alpha')).toBe(false);
    expect(capabilityAllowsProvider('additive-cache-accounting', 'openai')).toBe(false);
    expect(capabilityAllowsProvider('additive-cache-accounting', 'ox-alpha')).toBe(false);
  });

  it('does not render it for a codex or an opencode session', () => {
    expect(isCapabilityAvailable('live-usage-poll', { provider: 'openai', harness: 'codex' })).toBe(false);
    expect(isCapabilityAvailable('live-usage-poll', { provider: 'ox-alpha', harness: 'opencode' })).toBe(false);
  });

  it('closes a Claude-Code-specific gate for the other two harnesses', () => {
    expect(capabilityAllowsHarness('session-transcripts', 'codex')).toBe(false);
    expect(capabilityAllowsHarness('session-transcripts', 'opencode')).toBe(false);
    expect(isCapabilityAvailable('slash-commands', { provider: 'openai', harness: 'codex' })).toBe(false);
    expect(isCapabilityAvailable('cli-internals', { provider: 'ox-alpha', harness: 'opencode' })).toBe(false);
  });
});

describe('the two gates are independent', () => {
  // ADR 0040: neither column may be inferred from the other. Today's three pairs
  // are one-to-one, so the disagreements below are the cases that would pass
  // unnoticed if either gate were derived from its sibling.
  it('opens the provider gate while the harness gate stays shut', () => {
    expect(capabilityAllowsProvider('wire-system-prompt-outline', 'anthropic')).toBe(true);
    expect(capabilityAllowsHarness('wire-system-prompt-outline', 'codex')).toBe(false);
    expect(isCapabilityAvailable('wire-system-prompt-outline', { provider: 'anthropic', harness: 'codex' })).toBe(
      false,
    );
  });

  it('opens the harness gate while the provider gate stays shut', () => {
    expect(capabilityAllowsHarness('wire-system-prompt-outline', 'claude-code')).toBe(true);
    expect(capabilityAllowsProvider('wire-system-prompt-outline', 'openai')).toBe(false);
    expect(isCapabilityAvailable('wire-system-prompt-outline', { provider: 'openai', harness: 'claude-code' })).toBe(
      false,
    );
  });

  it('requires both to hold for a capability that declares both', () => {
    const declaration = capabilityDeclaration('prompt-cache-breakpoint-repair');
    expect(declaration.provider).toBe('prompt-cache-breakpoints');
    expect(declaration.harness).toBe('system-prompt-capture');
    expect(isCapabilityAvailable('prompt-cache-breakpoint-repair', { provider: 'anthropic', harness: 'codex' })).toBe(
      false,
    );
    expect(
      isCapabilityAvailable('prompt-cache-breakpoint-repair', { provider: 'ox-alpha', harness: 'claude-code' }),
    ).toBe(false);
  });

  it('reads only its own axis, so a provider-only capability ignores every harness', () => {
    for (const harness of HARNESS_IDS) {
      expect(capabilityAllowsHarness('subscription-usage-windows', harness)).toBe(true);
    }
  });

  it('reads only its own axis, so a harness-only capability ignores every provider', () => {
    for (const provider of PROVIDER_IDS) {
      expect(capabilityAllowsProvider('session-transcripts', provider)).toBe(true);
    }
  });
});

describe('an ungated capability is unaffected by either gate', () => {
  it('renders for every provider and harness pairing there is', () => {
    for (const provider of PROVIDER_IDS) {
      for (const harness of HARNESS_IDS) {
        expect(isCapabilityAvailable('overview', { provider, harness })).toBe(true);
        expect(isCapabilityAvailable('trends', { provider, harness })).toBe(true);
        expect(isCapabilityAvailable('pull-requests', { provider, harness })).toBe(true);
        expect(isCapabilityAvailable('cost-and-pricing', { provider, harness })).toBe(true);
      }
    }
  });

  it('declares null on both axes rather than a gate that always opens', () => {
    const declaration = capabilityDeclaration('overview');
    expect(declaration.provider).toBeNull();
    expect(declaration.harness).toBeNull();
  });
});

describe('the audit itself', () => {
  it('classifies every capability exactly once', () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
    expect(CAPABILITIES.length).toBe(CAPABILITY_IDS.length);
  });

  it('deletes nothing — every capability still renders for the pair it was written for', () => {
    // The campaign's first criterion: gating is not deletion. Whatever a gate
    // says about codex or ox, claude's own session must still see all of it.
    expect(capabilitiesFor(CLAUDE_SESSION)).toEqual(CAPABILITY_IDS);
  });

  it('gives every capability a surface and a rationale a reader can check', () => {
    for (const declaration of CAPABILITIES) {
      expect(declaration.surface.length).toBeGreaterThan(0);
      expect(declaration.rationale.length).toBeGreaterThan(0);
    }
  });

  it('leaves ungating the largest single class, and partitions every capability into exactly one', () => {
    const ungated = CAPABILITIES.filter((d) => d.provider === null && d.harness === null).length;
    const harnessOnly = CAPABILITIES.filter((d) => d.provider === null && d.harness !== null).length;
    const providerOnly = CAPABILITIES.filter((d) => d.provider !== null && d.harness === null).length;
    const both = CAPABILITIES.filter((d) => d.provider !== null && d.harness !== null).length;
    expect(ungated).toBeGreaterThan(harnessOnly);
    expect(ungated).toBeGreaterThan(providerOnly);
    expect(ungated).toBeGreaterThan(both);
    expect(ungated + harnessOnly + providerOnly + both).toBe(CAPABILITIES.length);
  });

  it('throws rather than guessing for an id it does not declare', () => {
    const unknownId: string = 'not-a-capability';
    // SAFETY: the closed union is what a TypeScript caller is held to; this cast
    // reaches the runtime guard that answers an untyped caller, which is the only
    // way that branch is observable.
    expect(() => capabilityDeclaration(unknownId as CapabilityId)).toThrow(/no capability declared/);
  });
});

describe('every harness gate names the state it actually reads', () => {
  // The three that parse `logs/sessions/<threadId>.md`, and nothing else. Six gates
  // used to declare `session-transcripts` without needing it.
  const TRANSCRIPT_READERS: readonly CapabilityId[] = [
    'session-transcripts',
    'live-session-graph',
    'session-suggestions',
  ];

  it('declares session-transcripts for exactly the capabilities that parse transcripts', () => {
    const declaring = CAPABILITIES.filter((d) => d.harness === 'session-transcripts').map((d) => d.id);
    expect(declaring).toEqual(TRANSCRIPT_READERS);
  });

  it('gates each device-configuration surface on the state it reads', () => {
    expect(capabilityDeclaration('hooks-and-plugins').harness).toBe('device-settings-file');
    expect(capabilityDeclaration('withheld-tools').harness).toBe('device-settings-file');
    expect(capabilityDeclaration('slash-commands').harness).toBe('user-defined-commands');
    expect(capabilityDeclaration('project-memory').harness).toBe('project-scoped-memory');
    expect(capabilityDeclaration('cli-internals').harness).toBe('installed-cli-bundle');
    expect(capabilityDeclaration('proxy-filters').harness).toBe('harness-injected-request-content');
  });

  it('shares one member between the two surfaces that read the same settings file', () => {
    // Evidence, not tidiness: `/hooks-plugins` and `/withheld` both resolve out of
    // `~/.claude/settings.json`, so a harness cannot offer one and not the other.
    expect(capabilityDeclaration('withheld-tools').harness).toBe(capabilityDeclaration('hooks-and-plugins').harness);
  });

  it('closes every repointed gate for the other two harnesses', () => {
    const repointed: readonly CapabilityId[] = [
      'hooks-and-plugins',
      'slash-commands',
      'cli-internals',
      'project-memory',
      'proxy-filters',
      'withheld-tools',
    ];
    for (const id of repointed) {
      expect(capabilityAllowsHarness(id, 'codex')).toBe(false);
      expect(capabilityAllowsHarness(id, 'opencode')).toBe(false);
      // Still ungated on the provider axis — repointing one axis must not have
      // leaked a gate onto the other. ADR 0040.
      for (const provider of PROVIDER_IDS) {
        expect(capabilityAllowsProvider(id, provider)).toBe(true);
      }
    }
  });
});

describe('the two supports helpers', () => {
  it('answers for the provider axis from the registered adapter', () => {
    expect(providerSupports('anthropic', 'additive-cache-counters')).toBe(true);
    expect(providerSupports('openai', 'additive-cache-counters')).toBe(false);
    expect(providerSupports('ox-alpha', 'wire-system-blocks')).toBe(false);
  });

  it("answers for the harness axis from ticket 01's own adapter", () => {
    expect(harnessSupports('claude-code', 'skim-cache')).toBe(true);
    expect(harnessSupports('codex', 'skim-cache')).toBe(false);
    expect(harnessSupports('opencode', 'session-transcripts')).toBe(false);
  });
});
