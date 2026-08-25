import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { computeDigest, digestsByDay } from '../src/digest.js';
import type { AuditSidecar } from '../src/types.js';
import { isClassifierPrompt } from '../src/wire-prompt.js';
import { makeSidecar } from './helpers.js';

/** A sidecar attributed to a stored prompt hash, in a named session. */
const call = (hash: string, sessionId: string, over: Partial<AuditSidecar> = {}): AuditSidecar =>
  makeSidecar({
    request: {
      toolCount: 2,
      toolsBytes: 24_000,
      systemBytes: 8_000,
      totalBytes: 60_000,
      system: { hash, blocks: 1, sections: 2 },
    },
    session: {
      sessionId,
      app: null,
      userAgent: null,
      account: null,
      metadataSessionId: null,
      deviceId: null,
    },
    ...over,
  });

describe('perCall', () => {
  it('divides by requests, not by day', () => {
    const d = computeDigest([makeSidecar(), makeSidecar(), makeSidecar()], { date: '2026-07-15' });
    assert.equal(d.perCall.all.requests, 3);
    // The mean is the day's total over three identical calls, so it equals one call.
    const one = computeDigest([makeSidecar()], { date: '2026-07-15' });
    assert.ok(Math.abs(d.perCall.all.costUsd - one.perCall.all.costUsd) < 1e-12);
    assert.equal(d.perCall.all.freshInputTokens, 100);
    assert.equal(d.perCall.all.fixedPrefixTokens, one.perCall.all.fixedPrefixTokens);
  });

  it('splits the classifier cohort out of the work cohort', () => {
    const sidecars = [call('work', 's1'), call('work', 's1'), call('cls', 's1'), call('cls', 's1')];
    const d = computeDigest(sidecars, { date: '2026-07-15', classifierHashes: new Set(['cls']) });

    assert.equal(d.perCall.identified, true);
    assert.equal(d.perCall.work.requests, 2);
    assert.equal(d.perCall.classifier.requests, 2);
    assert.equal(d.perCall.all.requests, 4);
    // share × value over the cohorts reproduces the all-request mean.
    const recomposed = 0.5 * d.perCall.work.costUsd + 0.5 * d.perCall.classifier.costUsd;
    assert.ok(Math.abs(recomposed - d.perCall.all.costUsd) < 1e-12);
  });

  it('records that identification never ran rather than reporting an empty cohort', () => {
    const d = computeDigest([call('work', 's1')], { date: '2026-07-15' });
    assert.equal(d.perCall.identified, false);
    assert.equal(d.perCall.classifier.requests, 0);
    assert.equal(d.perCall.work.requests, 1);
  });

  it('counts distinct session ids, and leaves sessionless requests out of the divisor', () => {
    const d = computeDigest([call('w', 's1'), call('w', 's1'), call('w', 's2'), makeSidecar()], {
      date: '2026-07-15',
    });
    assert.equal(d.perCall.all.sessions, 2);
    assert.equal(d.perCall.all.requests, 4);
    assert.equal(d.perCall.all.callsPerSession, 2);
  });

  it('reports zero rather than dividing by an empty cohort', () => {
    const d = computeDigest([], { date: '2026-07-15' });
    assert.equal(d.perCall.all.requests, 0);
    assert.equal(d.perCall.all.costUsd, 0);
    assert.equal(d.perCall.all.callsPerSession, 0);
    assert.equal(d.perCall.work.fixedPrefixTokens, 0);
  });

  it('carries the classifier set through the per-day trend fields', () => {
    const days = digestsByDay(
      [
        call('cls', 's1', { timestamp: '2026-07-15T10:00:00.000Z' }),
        call('w', 's1', { timestamp: '2026-07-15T11:00:00.000Z' }),
      ],
      { classifierHashes: new Set(['cls']) },
    );
    assert.equal(days.length, 1);
    assert.equal(days[0]!.perCall.classifier.requests, 1);
    assert.equal(days[0]!.perCall.work.requests, 1);
  });
});

describe('isClassifierPrompt', () => {
  const section = (heading: string) => ({ heading, level: 2, bytes: 100, block: 0 });

  it('needs both block headings', () => {
    assert.equal(isClassifierPrompt({ sections: [section('HARD BLOCK — never do'), section('SOFT BLOCK')] }), true);
    assert.equal(isClassifierPrompt({ sections: [section('HARD BLOCK')] }), false);
    assert.equal(isClassifierPrompt({ sections: [section('SOFT BLOCK')] }), false);
    assert.equal(isClassifierPrompt({ sections: [] }), false);
  });

  it('does not match an ordinary prompt that merely mentions blocking', () => {
    assert.equal(isClassifierPrompt({ sections: [section('Blocked commands'), section('Hard blocks')] }), false);
  });
});
