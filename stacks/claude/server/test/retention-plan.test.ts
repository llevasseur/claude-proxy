import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  isEvictable,
  logFileDay,
  planRetention,
  type RetentionCorpus,
  type RetentionWindow,
  resolveRetentionDays,
  resolveRetentionWindow,
  resolveToday,
  shiftDate,
} from '../src/retention.js';

/**
 * Every case here is a listing rather than a directory: the planner is pure, and
 * no test should be able to delete a real log to prove it works.
 */

const TODAY = '2026-08-02';

/** The three files one captured request writes, as the proxy names them. */
function triple(stem: string, bytes = 100): { name: string; bytes: number }[] {
  return [
    { name: `${stem}.audit.json`, bytes },
    { name: `${stem}.md`, bytes: bytes * 10 },
    { name: `${stem}.request.txt`, bytes: bytes * 20 },
  ];
}

function corpus(over: Partial<RetentionCorpus> = {}): RetentionCorpus {
  return { live: [], archive: [], ...over };
}

function plan(c: RetentionCorpus, retentionDays: RetentionWindow = 30) {
  return planRetention({ corpus: c, today: TODAY, retentionDays });
}

describe('archiving', () => {
  it("moves a past day out of the live directory and leaves today's alone", () => {
    const p = plan(
      corpus({
        live: [...triple('2026-08-01T10-00-00-000_anthropic'), ...triple('2026-08-02T10-00-00-000_anthropic')],
      }),
    );

    expect(p.archive.moves.map((m) => m.name)).toEqual([
      '2026-08-01T10-00-00-000_anthropic.audit.json',
      '2026-08-01T10-00-00-000_anthropic.md',
      '2026-08-01T10-00-00-000_anthropic.request.txt',
    ]);
    expect(p.archive.days).toEqual(['2026-08-01']);
  });

  it('leaves a tomorrow-stamped file in place — UTC runs ahead of the reporting day', () => {
    const p = plan(corpus({ live: triple('2026-08-03T02-00-00-000_anthropic') }));
    expect(p.archive.moves).toEqual([]);
  });

  it('never moves a name that carries no date, which is what protects the authored state', () => {
    const p = plan(
      corpus({
        live: [
          { name: 'suggestion-status.json', bytes: 10 },
          { name: 'claude-proxy.db', bytes: 999 },
          { name: 'runs.jsonl', bytes: 10 },
        ],
      }),
    );
    expect(p.archive.moves).toEqual([]);
    expect(p.evict.files).toEqual([]);
  });
});

describe('eviction', () => {
  const stem = '2026-06-01T10-00-00-000_anthropic';

  it('removes the bodies of an expired day and keeps its sidecar', () => {
    const p = plan(corpus({ archive: [{ day: '2026-06-01', files: triple(stem) }] }));

    expect(p.cutoff).toBe('2026-07-03');
    expect(p.evict.files.map((f) => f.name)).toEqual([`${stem}.md`, `${stem}.request.txt`]);
    expect(p.evict.files.some((f) => f.name.endsWith('.audit.json'))).toBe(false);
    // 10× + 20× the sidecar's 100 bytes.
    expect(p.evict.bytes).toBe(3000);
  });

  it('spares a day inside the window', () => {
    const p = plan(corpus({ archive: [{ day: '2026-07-13', files: triple('2026-07-13T10-00-00-000_anthropic') }] }));
    expect(p.evict.files).toEqual([]);
  });

  it('treats the cutoff day itself as still retained', () => {
    const onCutoff = shiftDate(TODAY, -30);
    const p = plan(corpus({ archive: [{ day: onCutoff, files: triple(`${onCutoff}T10-00-00-000_anthropic`) }] }));
    expect(p.evict.files).toEqual([]);
  });

  it('evicts a body archived by this same run into an already-expired day', () => {
    // Archiving and eviction happen in one pass, so a body that lands in an
    // expired day must not survive until tomorrow's run.
    const p = plan(corpus({ live: triple(stem) }));
    expect(p.archive.days).toEqual(['2026-06-01']);
    expect(p.evict.files.map((f) => f.name)).toEqual([`${stem}.md`, `${stem}.request.txt`]);
  });

  it('never evicts from the live directory — only archived days are candidates', () => {
    // The same expired stem, but with archiving disabled by pretending it is today's.
    const p = plan(corpus({ live: triple(`${TODAY}T10-00-00-000_anthropic`) }), 1);
    expect(p.archive.moves).toEqual([]);
    expect(p.evict.files).toEqual([]);
  });

  it('leaves anything that is not a body alone', () => {
    const p = plan(
      corpus({
        archive: [
          {
            day: '2026-06-01',
            files: [
              { name: `${stem}.audit.json`, bytes: 1 },
              { name: 'digest.json', bytes: 1 },
              { name: 'notes.txt', bytes: 1 },
            ],
          },
        ],
      }),
    );
    expect(p.evict.files).toEqual([]);
  });
});

describe('never', () => {
  const stem = '2026-06-01T10-00-00-000_anthropic';
  const expired = corpus({
    live: triple('2026-08-01T10-00-00-000_anthropic'),
    archive: [{ day: '2026-06-01', files: triple(stem) }],
  });

  it('evicts nothing, however far past the window a day is', () => {
    // `off` is a spelling the resolver accepts; the planner sees only what it resolves to.
    for (const spelling of ['never', 'off']) {
      const p = plan(expired, resolveRetentionWindow({ RETENTION_DAYS: spelling }));
      expect(p.evict.files).toEqual([]);
      expect(p.evict.days).toEqual([]);
      expect(p.evict.bytes).toBe(0);
      // No day expires, so there is no date to expire against.
      expect(p.cutoff).toBeNull();
    }
  });

  it('leaves archiving exactly as it would have been', () => {
    // The sentinel turns off one phase, so the archive section must be identical.
    const off = plan(expired, 'never');
    const on = plan(expired, 30);
    expect(off.archive).toEqual(on.archive);
    expect(on.evict.files.length).toBeGreaterThan(0);
  });

  it('keeps the bodies an ordinary window would have taken', () => {
    const off = plan(expired, 'never');
    const on = plan(expired, 30);
    expect(off.keep.bodyBytes).toBe(on.keep.bodyBytes + on.evict.bytes);
  });
});

describe('pricing what is kept', () => {
  it('counts surviving bytes, splits bodies out, and spans the retained days', () => {
    const p = plan(
      corpus({
        live: triple('2026-08-02T10-00-00-000_anthropic'),
        archive: [{ day: '2026-07-29', files: triple('2026-07-29T10-00-00-000_anthropic') }],
      }),
    );

    // Two triples of 100/1000/2000 bytes survive: 6200 in all, 6000 of it bodies.
    expect(p.keep.bytes).toBe(6200);
    expect(p.keep.bodyBytes).toBe(6000);
    expect(p.keep.days).toEqual(['2026-07-29', '2026-08-02']);
    // 29 July through 2 August inclusive, not the two days that hold a file.
    expect(p.keep.spanDays).toBe(5);
    expect(p.keep.bodyBytesPerDay).toBe(1200);
  });

  it('excludes what this run evicts, and counts what it does not', () => {
    const p = plan(
      corpus({
        archive: [
          { day: '2026-06-01', files: triple('2026-06-01T10-00-00-000_anthropic') },
          { day: '2026-07-29', files: triple('2026-07-29T10-00-00-000_anthropic') },
        ],
      }),
    );

    expect(p.evict.bytes).toBe(3000);
    // The expired day's sidecar is kept and its bodies are not.
    expect(p.keep.bytes).toBe(3200);
    expect(p.keep.bodyBytes).toBe(3000);
    expect(p.keep.days).toEqual(['2026-07-29']);
  });

  it('bounds the projection at the steady state a finite window implies', () => {
    const p = plan(corpus({ archive: [{ day: '2026-07-29', files: triple('2026-07-29T10-00-00-000_anthropic') }] }));

    // 3000 bytes over the 5-day span from 29 July: 600/day, held at 30 days.
    expect(p.keep.bodyBytesPerDay).toBe(600);
    expect(p.keep.steadyStateBytes).toBe(18_000);
    expect(p.keep.projection).toEqual([
      { days: 30, bytes: 18_000 },
      { days: 90, bytes: 18_000 },
      { days: 365, bytes: 18_000 },
    ]);
  });

  it('projects unbounded growth under never, which is the bill for keeping everything', () => {
    const p = plan(
      corpus({ archive: [{ day: '2026-07-29', files: triple('2026-07-29T10-00-00-000_anthropic') }] }),
      'never',
    );

    expect(p.keep.steadyStateBytes).toBeNull();
    expect(p.keep.projection).toEqual([
      { days: 30, bytes: 3000 + 600 * 30 },
      { days: 90, bytes: 3000 + 600 * 90 },
      { days: 365, bytes: 3000 + 600 * 365 },
    ]);
  });

  it('has no rate to project when nothing with a body is retained', () => {
    const p = plan(corpus({ live: [{ name: 'claude-proxy.db', bytes: 999 }] }));
    expect(p.keep.bytes).toBe(999);
    expect(p.keep.bodyBytes).toBe(0);
    expect(p.keep.spanDays).toBe(0);
    expect(p.keep.bodyBytesPerDay).toBe(0);
    expect(p.keep.projection.every((point) => point.bytes === 0)).toBe(true);
  });
});

describe('helpers', () => {
  it('reads the retention window off the environment, falling back to 30', () => {
    expect(resolveRetentionWindow({ RETENTION_DAYS: '7' })).toBe(7);
    expect(resolveRetentionWindow({})).toBe(30);
    expect(resolveRetentionWindow({ RETENTION_DAYS: 'nonsense' })).toBe(30);
    expect(resolveRetentionWindow({ RETENTION_DAYS: '-5' })).toBe(30);
  });

  it('accepts never and off as the way to say keep everything', () => {
    expect(resolveRetentionWindow({ RETENTION_DAYS: 'never' })).toBe('never');
    expect(resolveRetentionWindow({ RETENTION_DAYS: 'off' })).toBe('never');
    expect(resolveRetentionWindow({ RETENTION_DAYS: ' NEVER ' })).toBe('never');
  });

  it('rejects 0 rather than reading it as off', () => {
    // 0 puts the cutoff on today, which expires every archived day at once.
    expect(resolveRetentionWindow({ RETENTION_DAYS: '0' })).toBe(30);
    expect(planRetention({ corpus: corpus(), today: TODAY, retentionDays: 'never' }).cutoff).toBeNull();
  });

  it('reports never as the default to the callers that can only render a number', () => {
    expect(resolveRetentionDays({ RETENTION_DAYS: 'never' })).toBe(30);
    expect(resolveRetentionDays({ RETENTION_DAYS: '7' })).toBe(7);
    expect(resolveRetentionDays({ RETENTION_DAYS: '0' })).toBe(30);
  });

  it('counts whole days between two dates', () => {
    expect(daysBetween('2026-07-29', '2026-08-02')).toBe(4);
    expect(daysBetween('2026-08-02', '2026-08-02')).toBe(0);
    // Across a DST boundary, because the arithmetic is UTC.
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });

  it('resolves today in the configured zone', () => {
    // 00:30Z on the 3rd is still the 2nd in Eastern time.
    const at = new Date('2026-08-03T00:30:00.000Z');
    expect(resolveToday({ TIMEZONE: 'America/Toronto' }, at)).toBe('2026-08-02');
    expect(resolveToday({ TIMEZONE: 'UTC' }, at)).toBe('2026-08-03');
  });

  it('classifies filenames', () => {
    expect(logFileDay('2026-08-01T10-00-00-000_anthropic.md')).toBe('2026-08-01');
    expect(logFileDay('suggestion-status.json')).toBeNull();
    expect(isEvictable('x.audit.json')).toBe(false);
    expect(isEvictable('x.md')).toBe(true);
    expect(isEvictable('x.request.txt')).toBe(true);
  });
});
