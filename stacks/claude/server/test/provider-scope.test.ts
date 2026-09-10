import fs from 'node:fs';
import path from 'node:path';
import { API_ROUTES, apiRouteServedBy, MISDIRECTED_PROVIDER_STATUS } from '@agent-proxy/claude-core';
import { describe, expect, it } from 'vitest';
import { localReadFailureReason, ProviderUnreachableError } from '../src/db/provider-fanout.js';

/**
 * Criterion 1 of ticket 08, checked where it can actually be broken: **this server reads
 * claude's store and no other.**
 *
 * The manifest half is a property of the declarations, and the source half is a property of
 * the package. Both are asserted, because they fail in different ways — a route scoped to
 * another provider is a declaration someone added, while a direct read of a sibling
 * database is an import someone added, and neither would be caught by the other's check.
 */

const SERVED_PROVIDER = 'anthropic';
const SERVER_SRC = path.join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

describe('claude’s server is scoped to claude’s store', () => {
  /**
   * The declaration half. Every route this manifest carries is either claude's provider's
   * or nobody's, so there is no declared path by which a request to this server reaches the
   * OpenAI or Ox Alpha store.
   */
  it('declares no route belonging to another provider', () => {
    const foreign = API_ROUTES.filter((route) => !apiRouteServedBy(route, SERVED_PROVIDER));
    expect(
      foreign.map((route) => `${route.path} → ${route.provider}`),
      'claude’s manifest must declare only anthropic and agnostic routes',
    ).toEqual([]);
  });

  it('serves every route it declares, so the scope gate is a tripwire rather than a filter', () => {
    // Today the gate never fires: nothing in this manifest belongs to another provider.
    // That is the invariant above holding, and the gate is what keeps it holding if a
    // sibling-scoped route is ever added here by mistake — at which point this server
    // answers 421 instead of quietly reading its own store for another provider's question.
    expect(API_ROUTES.every((route) => apiRouteServedBy(route, SERVED_PROVIDER))).toBe(true);
    expect(MISDIRECTED_PROVIDER_STATUS).toBe(421);
  });

  /**
   * The source half. ADR 0046 gives each store one controller and ADR 0062 refuses a second
   * process reading a sibling's file, so the absence of any such read is the thing to check
   * — a scoped route table would not stop a handler opening `stacks/ox-alpha`'s database
   * directly.
   */
  it('never reaches into a sibling stack’s store', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SERVER_SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        // Skip prose: every mention in this package is a doc comment citing the ADRs.
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
        if (/stacks\/(codex|ox-alpha)|@agent-proxy\/(codex|ox)-/.test(code)) {
          offenders.push(`${path.relative(SERVER_SRC, file)}:${index + 1}: ${code}`);
        }
      }
    }
    expect(offenders, 'claude’s server must not read another stack’s store or import its packages').toEqual([]);
  });
});

describe('a failed read says which kind of failure it was', () => {
  it('calls an unreachable provider unreachable, not an unreadable store', () => {
    const reason = localReadFailureReason(
      'anthropic',
      new ProviderUnreachableError('http://localhost:8808', 'connect ECONNREFUSED'),
    );
    expect(reason.code).toBe('provider-unreachable');
  });

  it('classifies a store fault from the driver’s own wording', () => {
    expect(localReadFailureReason('anthropic', new Error('database is locked'))).toMatchObject({
      code: 'store-unreadable',
      fault: 'locked',
    });
    expect(localReadFailureReason('anthropic', new Error('database disk image is malformed'))).toMatchObject({
      code: 'store-unreadable',
      fault: 'corrupt',
    });
    expect(localReadFailureReason('anthropic', new Error('no such table: rate'))).toMatchObject({
      code: 'store-unreadable',
      fault: 'migrating',
    });
  });

  it('answers unknown for a fault it cannot place, rather than the nearest-looking one', () => {
    expect(localReadFailureReason('anthropic', new Error('something else entirely'))).toMatchObject({
      code: 'store-unreadable',
      fault: 'unknown',
    });
  });

  it('survives a thrown value that is not an Error', () => {
    expect(localReadFailureReason('anthropic', 'plain string').code).toBe('store-unreadable');
  });
});
