import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFallbacks, FALLBACK_REGISTRY, formatFallbackVerdicts } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';
import { fileSource } from '../src/db/source.js';
import { resolveLogDir } from '../src/logs.js';

/**
 * The deletion test for `packages/core/src/fallbacks.ts`.
 *
 * Every entry in that registry is a branch serving captures written before some
 * field existed. This reads the oldest capture the install *actually retains* and
 * fails for any entry whose field predates that floor: at that point no retained
 * capture can reach the branch, deleting it cannot change behaviour, and it is pure
 * carried weight. The failure names the file, the line and what to delete — it never
 * deletes anything itself, because removing a compatibility branch is a change
 * somebody reviews.
 *
 * **The floor is read as a listing, not a walk.** `fileSource.oldestDay` is two
 * `readdir`s — the archive's day directories plus the live root's dated filenames —
 * and opens no capture. That matters here specifically: the one other test that
 * reads the real `logs/archive` reads the corpus and takes minutes.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The entries carrying no `since`, written down so an undated fallback cannot pass
 * silently. Adding one to the registry without adding it here fails the suite: the
 * point of the registry is that nobody gets to leave a compatibility branch undated
 * without saying so out loud, and a list nobody has to update is a list nobody reads.
 */
const ACKNOWLEDGED_UNDATED = ['digest-legacy-cache-hit-ratio', 'request-filename-legacy-colon'];

describe('the fallback registry describes real code', () => {
  it('gives every entry a unique id', () => {
    const ids = FALLBACK_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('dates every entry as a reporting day or as nothing at all', () => {
    for (const entry of FALLBACK_REGISTRY) {
      if (entry.since !== null) expect(entry.since, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('still points each entry at the line holding its branch', async () => {
    const wrong: string[] = [];
    const byFile = new Map<string, typeof FALLBACK_REGISTRY>();
    for (const entry of FALLBACK_REGISTRY) {
      byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
    }

    for (const [file, entries] of byFile) {
      const lines = (await readFile(path.join(REPO_ROOT, file), 'utf8')).split('\n');
      for (const entry of entries) {
        const line = lines[entry.line - 1];
        if (line === undefined || !line.includes(entry.match)) {
          wrong.push(`${entry.id}: ${file}:${entry.line} no longer contains ${JSON.stringify(entry.match)}`);
        }
      }
    }

    // A line number is the whole anchor, and line numbers move. Re-point the entry
    // rather than loosening the match — a registry that drifts off its own code
    // retires the wrong branch, which is worse than retiring none.
    expect(wrong, `registry anchors have drifted:\n${wrong.join('\n')}`).toEqual([]);
  });
});

describe('what the retained corpus can still reach', () => {
  it('names every fallback no retained capture reaches any more', async () => {
    const logDir = resolveLogDir();
    const floor = await fileSource.oldestDay(logDir);
    const verdicts = auditFallbacks(FALLBACK_REGISTRY, floor);
    const retirable = verdicts.filter((v) => v.status === 'retirable');

    // Not a threshold to tune. `logs/` holds roughly today plus a rolling archive,
    // so this goes red on its own as the floor moves — that is the whole mechanism,
    // and the fix is to delete the branch it names, not to re-date the entry.
    expect(
      retirable,
      `no capture retained since ${floor} can reach these any more — delete them:\n${formatFallbackVerdicts(retirable)}`,
    ).toEqual([]);
  });

  it('reports the undated entries rather than letting them pass silently', () => {
    const undated = auditFallbacks(FALLBACK_REGISTRY, null)
      .filter((v) => v.status === 'undated')
      .map((v) => v.entry.id);

    expect(undated.sort(), 'an undated fallback must be acknowledged in ACKNOWLEDGED_UNDATED').toEqual(
      [...ACKNOWLEDGED_UNDATED].sort(),
    );
  });
});

describe('the floor decides an entry strictly', () => {
  const entry = FALLBACK_REGISTRY.find((e) => e.since !== null)!;
  const dated = { ...entry, id: 'probe', since: '2026-07-20' };

  it('retires a field that predates the oldest retained day outright', () => {
    expect(auditFallbacks([dated], '2026-07-21')[0]?.status).toBe('retirable');
  });

  it('keeps a field introduced on the floor day, whose day is only half covered', () => {
    expect(auditFallbacks([dated], '2026-07-20')[0]?.status).toBe('reachable');
  });

  it('keeps a field newer than anything retained', () => {
    expect(auditFallbacks([dated], '2026-07-01')[0]?.status).toBe('reachable');
  });

  it('decides nothing at all against an empty corpus', () => {
    expect(auditFallbacks([dated], null)[0]?.status).toBe('unproven');
  });

  it('reads an undated entry as undated however old the floor is', () => {
    expect(auditFallbacks([{ ...dated, since: null }], '2030-01-01')[0]?.status).toBe('undated');
  });
});
