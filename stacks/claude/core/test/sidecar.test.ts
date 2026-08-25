import { describe, expect, it } from 'vitest';
import type { HarnessId, ProviderId } from '../src/adapter-seam.js';
import { claudeCodeHarnessAdapter, stampFromHarness } from '../src/harness-adapter.js';
import { anthropicProviderAdapter, stampFromProvider } from '../src/provider-adapter.js';
import {
  assertSanitizedSidecar,
  type CapturingAdapters,
  FORBIDDEN_SIDECAR_KEYS,
  readSidecar,
  readSidecarSchemaVersion,
  SIDECAR_PROVENANCE_KEYS,
  SIDECAR_SCHEMA_V1,
  SIDECAR_SCHEMA_V2,
  SidecarValidationError,
  toSidecarV2,
} from '../src/sidecar.js';

/**
 * The body shape claude's proxy has always written, trimmed to the fields these
 * tests turn on. It carries `tools` and `request`, which is the point: both are
 * counts and hashes rather than content, and a sanitizer that rejected them
 * would reject every real capture in this repository.
 */
const v1Body = Object.freeze({
  timestamp: '2026-08-25T12:00:00.000Z',
  model: 'claude-opus-4',
  endpoint: 'POST /v1/messages',
  statusCode: 200,
  tokens: Object.freeze({ input: 120, output: 45, cacheRead: 900, cacheCreation: 30, realInput: 1050 }),
  request: Object.freeze({ toolCount: 3, toolsBytes: 2048, systemBytes: 512, totalBytes: 4096 }),
  tools: Object.freeze([Object.freeze({ name: 'Read', bytes: 700, estTokens: 175 })]),
});

const capturedByClaude: CapturingAdapters = Object.freeze({
  provider: 'anthropic',
  harness: 'claude-code',
  adapterVersion: anthropicProviderAdapter.adapterVersion,
});

/**
 * JSON round-trip, which is what a sidecar actually survives on disk.
 *
 * `unknown` in and `unknown` out is the point rather than a gap: this stands in
 * for the untyped value a reader gets back from `JSON.parse`, and typing it
 * would test a stronger input than `readSidecar` is ever handed.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- models the untyped JSON.parse result; see above.
function throughDisk(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('a reader tells v1 from v2 by one dedicated field', () => {
  it('reads a missing schemaVersion as v1', () => {
    expect(readSidecarSchemaVersion(v1Body)).toBe(SIDECAR_SCHEMA_V1);
  });

  it('reads a stated schemaVersion as that version', () => {
    expect(readSidecarSchemaVersion({ ...v1Body, schemaVersion: 2 })).toBe(SIDECAR_SCHEMA_V2);
    expect(readSidecarSchemaVersion({ ...v1Body, schemaVersion: 1 })).toBe(SIDECAR_SCHEMA_V1);
  });

  it('never infers the version from which other keys are present', () => {
    // Every v2 discriminator present, but no `schemaVersion`. A reader that
    // sniffed keys would call this v2; this one calls it v1, from the one field.
    const looksLikeV2 = { ...v1Body, provider: 'anthropic', harness: 'claude-code', adapterVersion: 1 };
    expect(readSidecarSchemaVersion(looksLikeV2)).toBe(SIDECAR_SCHEMA_V1);
  });

  it('rejects a version from a future writer rather than falling back to v1', () => {
    expect(() => readSidecarSchemaVersion({ ...v1Body, schemaVersion: 3 })).toThrow(SidecarValidationError);
    expect(() => readSidecarSchemaVersion({ ...v1Body, schemaVersion: '2' })).toThrow(SidecarValidationError);
  });
});

describe('a v2 sidecar survives write-then-read with every field intact', () => {
  it('round-trips the provenance header and the whole body', () => {
    const stamp = stampFromProvider(anthropicProviderAdapter, {
      harness: 'claude-code',
      model: 'claude-opus-4',
    });
    const written = toSidecarV2(v1Body, stamp);

    expect(written.schemaVersion).toBe(SIDECAR_SCHEMA_V2);
    expect(written.provider).toBe('anthropic');
    expect(written.harness).toBe('claude-code');
    expect(written.adapterVersion).toBe(anthropicProviderAdapter.adapterVersion);

    const read = readSidecar(throughDisk(written), { capturedBy: capturedByClaude });

    expect(read.schemaVersion).toBe(SIDECAR_SCHEMA_V2);
    expect(read.stampSource).toBe('payload');
    expect(read.stamp).toEqual(stamp);
    // The body comes back exactly as it went in. The three keys v2 adds are
    // stripped; `model` stays, because v1 already carried it and v2 only
    // promoted it into the header.
    expect(read.body).toEqual(v1Body);
  });

  it('keeps provider and harness independent, so an unusual pairing survives', () => {
    // If either axis were derived from the other this pairing could not round-trip.
    const stamp = stampFromHarness(claudeCodeHarnessAdapter, { provider: 'ox-alpha', model: 'gpt-5' });
    const read = readSidecar(throughDisk(toSidecarV2({ endpoint: '/v1/responses' }, stamp)), {
      capturedBy: capturedByClaude,
    });

    expect(read.stamp.provider).toBe('ox-alpha');
    expect(read.stamp.harness).toBe('claude-code');
  });

  it('refuses a body that already carries a provenance key', () => {
    const stamp = stampFromProvider(anthropicProviderAdapter, { harness: 'claude-code', model: 'claude-opus-4' });
    expect(() => toSidecarV2({ provider: 'openai' }, stamp)).toThrow(SidecarValidationError);
    expect(() => toSidecarV2({ model: 'a-different-model' }, stamp)).toThrow(SidecarValidationError);
  });
});

describe('a v1 sidecar still parses and resolves a provider', () => {
  it('resolves both axes from the adapter that captured it, at read time', () => {
    const read = readSidecar(throughDisk(v1Body), { capturedBy: capturedByClaude });

    expect(read.schemaVersion).toBe(SIDECAR_SCHEMA_V1);
    expect(read.stampSource).toBe('capturing-adapter');
    expect(read.stamp.provider).toBe('anthropic');
    expect(read.stamp.harness).toBe('claude-code');
    expect(read.stamp.model).toBe('claude-opus-4');
  });

  it('resolves to whichever adapter captured it rather than to a hardcoded default', () => {
    const capturedByOx: CapturingAdapters = { provider: 'ox-alpha', harness: 'opencode', adapterVersion: 1 };
    const read = readSidecar(throughDisk(v1Body), { capturedBy: capturedByOx });

    expect(read.stamp.provider).toBe('ox-alpha');
    expect(read.stamp.harness).toBe('opencode');
  });

  it('never rewrites the v1 payload in place', () => {
    // SAFETY: `v1Body` is an object literal, so its JSON round-trip is an object.
    // The assertion is only so the `not.toHaveProperty` checks below can be written.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the shape under test is the untyped on-disk payload.
    const onDisk = throughDisk(v1Body) as Record<string, unknown>;
    const before = JSON.stringify(onDisk);

    const read = readSidecar(onDisk, { capturedBy: capturedByClaude });

    // The input is byte-identical afterwards, and no discriminator was spliced in.
    expect(JSON.stringify(onDisk)).toBe(before);
    expect(onDisk).not.toHaveProperty('schemaVersion');
    expect(onDisk).not.toHaveProperty('provider');
    expect(read.body).toEqual(v1Body);
  });
});

describe('an unregistered provider is rejected loudly, never defaulted', () => {
  // SAFETY: both literals are members of their unions — they are the shipped
  // anthropic and claude-code ids. The assertions only widen the inferred string
  // literals to the union types `RecordStamp` declares.
  const stamp = {
    provider: 'anthropic' as ProviderId,
    harness: 'claude-code' as HarnessId,
    model: 'm',
    adapterVersion: 1,
  };

  it('throws on a discriminator naming no registered provider adapter', () => {
    const rogue = { ...toSidecarV2({ endpoint: '/v1/messages' }, stamp), provider: 'deepmind' };

    expect(() => readSidecar(rogue, { capturedBy: capturedByClaude })).toThrow(SidecarValidationError);
    expect(() => readSidecar(rogue, { capturedBy: capturedByClaude })).toThrow(/names no registered provider adapter/);
  });

  it('does not quietly fall back to the capturing adapter', () => {
    const rogue = { ...toSidecarV2({ endpoint: '/v1/messages' }, stamp), provider: 'deepmind' };
    let resolved: string | null = null;
    try {
      resolved = readSidecar(rogue, { capturedBy: capturedByClaude }).stamp.provider;
    } catch {
      resolved = null;
    }
    // The capturing adapter is `anthropic`; a silent default would have produced it.
    expect(resolved).toBeNull();
  });

  it('throws on a discriminator naming no registered harness adapter', () => {
    const rogue = { ...toSidecarV2({ endpoint: '/v1/messages' }, stamp), harness: 'emacs' };

    expect(() => readSidecar(rogue, { capturedBy: capturedByClaude })).toThrow(/names no registered harness adapter/);
  });

  it('honours a caller-supplied registry rather than only the shipped one', () => {
    const emptyProviders = { ids: (): readonly ProviderId[] => [] };

    expect(() => readSidecar(throughDisk(v1Body), { capturedBy: capturedByClaude, providers: emptyProviders })).toThrow(
      SidecarValidationError,
    );
  });
});

describe('sidecars stay sanitized, and cost is not among their fields', () => {
  it('rejects a persisted body, at the top level or nested', () => {
    expect(() => assertSanitizedSidecar({ ...v1Body, requestBody: '{"messages":[]}' })).toThrow(SidecarValidationError);
    expect(() => assertSanitizedSidecar({ ...v1Body, request: { toolCount: 1, body: 'hello' } })).toThrow(
      SidecarValidationError,
    );
    expect(() => assertSanitizedSidecar({ tools: [{ name: 'Read', toolDefinitions: [] }] })).toThrow(
      SidecarValidationError,
    );
  });

  it('rejects credentials, cookies and arbitrary headers', () => {
    for (const key of ['apiKey', 'authorization', 'cookie', 'headers', 'secret']) {
      expect(() => assertSanitizedSidecar({ ...v1Body, [key]: 'x' })).toThrow(SidecarValidationError);
    }
  });

  it('rejects cost and pricing_source, which are resolved at read time', () => {
    expect(FORBIDDEN_SIDECAR_KEYS).toContain('cost');
    expect(FORBIDDEN_SIDECAR_KEYS).toContain('pricing_source');
    expect(() => assertSanitizedSidecar({ ...v1Body, cost: { amountUsd: '0.12' } })).toThrow(SidecarValidationError);
    expect(() => assertSanitizedSidecar({ ...v1Body, pricingSource: 'catalogue' })).toThrow(SidecarValidationError);
  });

  it('leaves the sanitized shape claude already writes alone', () => {
    expect(() => assertSanitizedSidecar(v1Body)).not.toThrow();
  });

  it('keeps cost out of the provenance header entirely', () => {
    expect(SIDECAR_PROVENANCE_KEYS).toEqual(['schemaVersion', 'provider', 'harness', 'model', 'adapterVersion']);
    expect(SIDECAR_PROVENANCE_KEYS).not.toContain('cost');
    expect(SIDECAR_PROVENANCE_KEYS).not.toContain('pricingSource');
  });

  it('refuses to read a sidecar carrying a forbidden field, whatever its version', () => {
    expect(() => readSidecar({ ...v1Body, responseBody: 'text' }, { capturedBy: capturedByClaude })).toThrow(
      SidecarValidationError,
    );
  });
});
