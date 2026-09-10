import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { RECORD_ADAPTER_VERSION, RECORD_HARNESS, RECORD_PROVIDER } from '../src/record-stamp.ts';

/**
 * codex's server restates the adapter contract's vocabulary rather than
 * importing it, because the contract lives in another stack's core and every
 * core stays free of runtime dependencies. Restating it invites silent drift —
 * the same defect ticket 02 found in the proxy, where a hardcoded adapter
 * version would have stayed at 1 forever with every suite green.
 *
 * So the constants are pinned here against the contract's own source, read as
 * text. A version bump in `provider-adapter.ts` fails this test rather than
 * quietly stamping stale records.
 */
const CONTRACT = new URL('../../../claude/core/src/provider-adapter.ts', import.meta.url);
const SEAM = new URL('../../../claude/core/src/adapter-seam.ts', import.meta.url);

describe('the record stamp tracks the adapter contract', () => {
  test('the provider id is one the contract declares', () => {
    const seam = readFileSync(SEAM, 'utf8');
    const providerIds = seam.match(/export type ProviderId =([^;]+);/)?.[1] ?? '';
    expect(providerIds).toContain(`'${RECORD_PROVIDER}'`);
  });

  test('the harness id is one the contract declares', () => {
    const seam = readFileSync(SEAM, 'utf8');
    const harnessIds = seam.match(/export type HarnessId =([^;]+);/)?.[1] ?? '';
    expect(harnessIds).toContain(`'${RECORD_HARNESS}'`);
  });

  test('the adapter version matches the openai provider adapter', () => {
    const contract = readFileSync(CONTRACT, 'utf8');
    const declaration = contract.match(/provider:\s*'openai',\s*\n\s*adapterVersion:\s*(\d+)/);
    expect(declaration, 'openAiProviderAdapter no longer declares its version where this test looks').not.toBeNull();
    expect(Number(declaration?.[1])).toBe(RECORD_ADAPTER_VERSION);
  });

  test('provider and harness are not the same axis', () => {
    // ADR 0040: Codex is not OpenAI. If these ever coincide, something derived
    // one from the other.
    expect(RECORD_PROVIDER).not.toBe(RECORD_HARNESS);
  });
});
