/**
 * The versioned `HarnessAdapter` contract and the harness registry.
 *
 * A harness owns **session shape and transcript format**. It does not own the
 * wire contract or pricing — those are the provider's, in `provider-adapter.ts`,
 * which this file does not import and which does not import this one. The two
 * registries are siblings, not layers.
 *
 * ## Capabilities are how gating works, and gating is not deletion
 *
 * The campaign's rule is that every existing capability survives: what is
 * Claude-Code-specific gates on the harness, so it answers `false` and does not
 * render for a codex or an opencode session, rather than being removed. This
 * file lands the mechanism for that; the later gating ticket is what populates
 * it for the other two harnesses from each stack's own evidence.
 *
 * **An undeclared capability is `false`.** That is the safe direction and it is
 * the reason the codex and opencode adapters ship with empty sets: this package
 * has evidence for what Claude Code does and none yet for what the other two do,
 * and inventing a `true` here would render a surface against a session that
 * cannot feed it. Empty means "not yet established", never "known absent".
 */

import type { HarnessId, ProviderId, RecordStamp } from './adapter-seam.js';

/**
 * A capability a dashboard surface may gate on.
 *
 * Deliberately a closed union: a surface gating on a free-form string would fail
 * open on a typo, which is the failure mode the whole gate exists to avoid.
 */
export type HarnessCapability =
  /** Writes a per-thread transcript this repository can read back. */
  | 'session-transcripts'
  /** Captures the request's system prompt as a re-identifiable artifact. */
  | 'system-prompt-capture'
  /** Supports the app-layer response cache, distinct from any prefix cache. */
  | 'skim-cache'
  /** Keeps a machine-wide settings file on disk, declaring what it loads and what it withholds. */
  | 'device-settings-file'
  /** Lets a user define named commands on disk, and marks their invocation in its own requests. */
  | 'user-defined-commands'
  /** Keeps per-project instruction files on disk, keyed by the project they belong to. */
  | 'project-scoped-memory'
  /** Ships its own program bundle on the device, readable as text at a resolvable path. */
  | 'installed-cli-bundle'
  /** Injects content into its own requests that its own settings offer no way to suppress. */
  | 'harness-injected-request-content';

/**
 * The versioned harness contract.
 *
 * `adapterVersion` is the value that lands in a record's `adapter_version`
 * column for a record *this* adapter produced. It moves independently of any
 * provider adapter's version.
 */
export interface HarnessAdapter {
  readonly harness: HarnessId;
  readonly adapterVersion: number;
  /** What this harness is known to support. Order is not meaningful. */
  readonly capabilities: readonly HarnessCapability[];
  /** `false` for anything not declared above. */
  supports(capability: HarnessCapability): boolean;
}

function harnessAdapter(
  harness: HarnessId,
  adapterVersion: number,
  capabilities: readonly HarnessCapability[],
): HarnessAdapter {
  const declared = Object.freeze([...capabilities]);
  return Object.freeze({
    harness,
    adapterVersion,
    capabilities: declared,
    supports(capability: HarnessCapability): boolean {
      return declared.includes(capability);
    },
  });
}

/**
 * Claude Code. Every capability here is one this repository demonstrates against
 * something it actually reads: per-thread session transcripts, system prompts
 * captured by hash, a skim cache, `~/.claude/settings.json`, the command
 * definitions under `~/.claude/commands/`, the per-project memory files under
 * `~/.claude/projects/`, the installed CLI bundle, and the reminders the client
 * injects into its own requests.
 *
 * **Naming the evidence rather than the harness is the point.** Each member says
 * what state has to exist for a surface to have anything to render, so a second
 * harness that keeps a settings file declares `device-settings-file` on its own
 * evidence rather than inheriting anything from this list.
 */
export const claudeCodeHarnessAdapter: HarnessAdapter = harnessAdapter('claude-code', 1, [
  'session-transcripts',
  'system-prompt-capture',
  'skim-cache',
  'device-settings-file',
  'user-defined-commands',
  'project-scoped-memory',
  'installed-cli-bundle',
  'harness-injected-request-content',
]);

/** Codex. Capabilities are not yet established here — see the file header. */
export const codexHarnessAdapter: HarnessAdapter = harnessAdapter('codex', 1, []);

/** opencode. Capabilities are not yet established here — see the file header. */
export const opencodeHarnessAdapter: HarnessAdapter = harnessAdapter('opencode', 1, []);

/**
 * A registry keyed by harness, and by nothing else. It is not indexed by
 * provider, holds no combined key, and has no provider-aware method.
 */
export interface HarnessRegistry {
  /** Replaces any adapter already registered for the same harness. */
  register(adapter: HarnessAdapter): void;
  /** Throws when the harness has no adapter. */
  get(harness: HarnessId): HarnessAdapter;
  find(harness: HarnessId): HarnessAdapter | undefined;
  /** Harnesses with an adapter, in registration order. */
  ids(): readonly HarnessId[];
}

export function createHarnessRegistry(): HarnessRegistry {
  const adapters = new Map<HarnessId, HarnessAdapter>();
  return {
    register(adapter: HarnessAdapter): void {
      adapters.set(adapter.harness, adapter);
    },
    get(harness: HarnessId): HarnessAdapter {
      const adapter = adapters.get(harness);
      if (adapter === undefined) {
        throw new Error(`no harness adapter registered for '${harness}'`);
      }
      return adapter;
    },
    find(harness: HarnessId): HarnessAdapter | undefined {
      return adapters.get(harness);
    },
    ids(): readonly HarnessId[] {
      return [...adapters.keys()];
    },
  };
}

/**
 * The three harness adapters this repository ships, registered independently of
 * the provider registry. Adding a fourth harness is one more `register` call
 * here and no change at all in `provider-adapter.ts`.
 */
export const harnessRegistry: HarnessRegistry = createHarnessRegistry();
harnessRegistry.register(claudeCodeHarnessAdapter);
harnessRegistry.register(codexHarnessAdapter);
harnessRegistry.register(opencodeHarnessAdapter);

/**
 * Stamp a record this harness adapter produced.
 *
 * `provider` is a **required argument**, never read off the adapter, for the
 * same reason `stampFromProvider` demands a harness: neither axis may derive the
 * other, so the only way to obtain a stamp is to name both.
 */
export function stampFromHarness(
  adapter: HarnessAdapter,
  context: { readonly provider: ProviderId; readonly model: string },
): RecordStamp {
  return Object.freeze({
    provider: context.provider,
    harness: adapter.harness,
    model: context.model,
    adapterVersion: adapter.adapterVersion,
  });
}
