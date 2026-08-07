import { describe, expect, it } from 'vitest';
import {
  autoLearningRate,
  buildTfIdf,
  clampPerplexity,
  cosineDistance,
  embeddingTerms,
  type ProjectableSession,
  projectSessions,
  sessionCommand,
  sessionSubjectText,
  tsne,
} from '../src/embedding.js';
import type { SessionNode } from '../src/sessions.js';

function node(text: string, index = 0): SessionNode {
  return {
    index,
    type: 'decision',
    text,
    tool: null,
    task: null,
    interruption: null,
    interrupted: false,
    message: null,
    turn: null,
  };
}

function session(overrides: Partial<ProjectableSession> = {}): ProjectableSession {
  return {
    threadId: '0123456789abcdef',
    model: 'claude-opus-4-8',
    sessionId: 'sess-1',
    started: '2026-08-01T10:00:00.000Z',
    tasks: 1,
    decisions: 2,
    tools: 3,
    errors: 0,
    firstTask: null,
    title: null,
    subtitle: null,
    derivedTitle: null,
    nodes: [],
    modified: '2026-08-01T11:00:00.000Z',
    ...overrides,
  };
}

/** The envelope shape the CLI actually sends, definition inlined after the tags. */
function envelope(command: string, args: string, definition = ''): string {
  return `<command-message>${command}</command-message> <command-name>/${command}</command-name> <command-args>${args}</command-args>${definition}`;
}

describe('embeddingTerms', () => {
  it('lowercases, drops stop words, and splits paths into their words', () => {
    expect(embeddingTerms('Fix the Scroll in Read(file_path=src/panel.tsx)')).toEqual([
      'fix',
      'scroll',
      'read',
      'file',
      'path',
      'src',
      'panel',
      'tsx',
    ]);
  });

  it('splits camelCase into its words', () => {
    expect(embeddingTerms('parseSessionNodes')).toEqual(['parse', 'session', 'nodes']);
  });

  it('drops bare numbers, short fragments, and hex blobs', () => {
    // `a` and `of` are too short; 42 is not letter-led; the sha is a hex blob.
    expect(embeddingTerms('a bug of 42 in deadbeefcafe1234')).toEqual(['bug']);
  });

  it('drops implausibly long tokens', () => {
    expect(embeddingTerms(`subject ${'z'.repeat(40)}`)).toEqual(['subject']);
  });
});

describe('sessionSubjectText', () => {
  it("embeds a command run's criteria and not its inlined definition", () => {
    const definition = ' Take a task from a plain-language description all the way to an open PR.';
    const text = sessionSubjectText(
      session({ subtitle: envelope('task', 'fix the artifact panel scroll', definition) }),
    );
    expect(text).toContain('artifact panel scroll');
    // The boilerplate every /task run shares must not reach the vector — otherwise the map
    // clusters runs by command rather than by subject.
    expect(text).not.toContain('plain-language description');
    expect(text).not.toContain('command-name');
  });

  it('keeps an ordinary session’s subtitle as written', () => {
    const text = sessionSubjectText(session({ subtitle: 'why does the dev server pick port 8788' }));
    expect(text).toContain('port 8788');
  });

  it('includes step text and caps how much one session contributes', () => {
    const long = session({ nodes: [node('x'.repeat(50_000))] });
    expect(sessionSubjectText(long).length).toBeLessThanOrEqual(20_100);
  });
});

describe('sessionCommand', () => {
  it('reads the command off the envelope, without its slash', () => {
    expect(sessionCommand(session({ subtitle: envelope('god', 'ship it') }))).toBe('god');
  });

  it('falls back to the first task when the subtitle carries no envelope', () => {
    expect(sessionCommand(session({ subtitle: null, firstTask: envelope('teach', 'explain SSE') }))).toBe('teach');
  });

  it('is null for an ordinary session', () => {
    expect(sessionCommand(session({ subtitle: 'just a question about caching' }))).toBeNull();
  });
});

describe('buildTfIdf', () => {
  it('L2-normalizes every vector', () => {
    // `maxDocumentFrequencyRatio: 1` keeps the whole vocabulary, so every vector has weight —
    // the default ceiling would filter this tiny corpus down to almost nothing.
    const { vectors } = buildTfIdf(
      [
        ['alpha', 'beta', 'beta'],
        ['beta', 'gamma'],
        ['alpha', 'gamma', 'delta'],
        ['delta', 'alpha'],
        ['gamma', 'beta'],
      ],
      { maxDocumentFrequencyRatio: 1 },
    );
    for (const vector of vectors) {
      expect(vector.size).toBeGreaterThan(0);
      let norm = 0;
      for (const weight of vector.values()) norm += weight * weight;
      expect(Math.sqrt(norm)).toBeCloseTo(1, 10);
    }
  });

  it('drops a term carried by more than half the corpus', () => {
    // `every` is in all six documents, so it can never separate two of them.
    const docs = Array.from({ length: 6 }, (_, i) => ['every', `unique${i}`, `shared${i % 2}`]);
    const { vocabulary } = buildTfIdf(docs);
    expect(vocabulary).not.toContain('every');
    expect(vocabulary).toContain('shared0');
  });

  it('drops a term appearing in only one document once the corpus is large enough', () => {
    const docs = Array.from({ length: 6 }, (_, i) => [`only${i}`, `shared${i % 2}`]);
    const { vocabulary } = buildTfIdf(docs);
    expect(vocabulary).not.toContain('only3');
    expect(vocabulary).toContain('shared1');
  });

  it('keeps single-document terms in a corpus too small for the floor to mean anything', () => {
    const { vocabulary } = buildTfIdf([['alpha'], ['beta']]);
    expect(vocabulary).toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('bounds the vocabulary', () => {
    const docs = Array.from({ length: 8 }, () => Array.from({ length: 500 }, (_, j) => `term${j}`));
    const { vocabulary } = buildTfIdf(docs, { maxTerms: 25, maxDocumentFrequencyRatio: 1 });
    expect(vocabulary).toHaveLength(25);
  });

  it('returns nothing for an empty corpus', () => {
    expect(buildTfIdf([])).toEqual({ vectors: [], vocabulary: [] });
  });
});

describe('cosineDistance', () => {
  it('is 0 for identical vectors and 1 for disjoint ones', () => {
    const a = new Map([['x', 1]]);
    const b = new Map([['y', 1]]);
    expect(cosineDistance(a, a)).toBeCloseTo(0, 10);
    expect(cosineDistance(a, b)).toBeCloseTo(1, 10);
  });

  it('is symmetric regardless of which vector is larger', () => {
    const a = new Map([
      ['x', 0.6],
      ['y', 0.8],
    ]);
    const b = new Map([['x', 1]]);
    expect(cosineDistance(a, b)).toBeCloseTo(cosineDistance(b, a), 12);
  });
});

describe('clampPerplexity', () => {
  it('holds a requested perplexity below the corpus bound', () => {
    expect(clampPerplexity(5, 100)).toBe(5);
  });

  it('clamps against a small corpus rather than collapsing the map', () => {
    expect(clampPerplexity(30, 10)).toBe(3);
    expect(clampPerplexity(30, 2)).toBe(1);
  });
});

describe('autoLearningRate', () => {
  it('holds a floor for a small corpus and scales up for a large one', () => {
    expect(autoLearningRate(6)).toBe(50);
    expect(autoLearningRate(344)).toBe(50);
    expect(autoLearningRate(16_000)).toBe(1_000);
  });
});

describe('tsne', () => {
  it('handles the degenerate corpus sizes', () => {
    expect(tsne([])).toEqual([]);
    expect(tsne([[0]])).toEqual([{ x: 0, y: 0 }]);
  });

  it('is deterministic for a given seed', () => {
    const squared = [
      [0, 1, 4],
      [1, 0, 4],
      [4, 4, 0],
    ];
    expect(tsne(squared, { iterations: 80 })).toEqual(tsne(squared, { iterations: 80 }));
  });

  it('separates two tight groups, keeping each group closer to itself than to the other', () => {
    // Six points: {0,1,2} mutually near, {3,4,5} mutually near, the groups far apart.
    const n = 6;
    const squared = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : Math.floor(i / 3) === Math.floor(j / 3) ? 0.04 : 1.44)),
    );
    const points = tsne(squared, { perplexity: 2, iterations: 400 });
    const spread = (a: number, b: number) => Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y);
    const within = Math.max(spread(0, 1), spread(0, 2), spread(1, 2), spread(3, 4), spread(3, 5), spread(4, 5));
    const between = Math.min(spread(0, 3), spread(1, 4), spread(2, 5));
    expect(within).toBeLessThan(between);
  });

  it('scales the widest axis to [-1, 1]', () => {
    const squared = [
      [0, 1, 4, 9],
      [1, 0, 1, 4],
      [4, 1, 0, 1],
      [9, 4, 1, 0],
    ];
    const points = tsne(squared, { iterations: 200 });
    const extent = Math.max(...points.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
    expect(extent).toBeCloseTo(1, 10);
  });

  it('separates tight groups even when the nearest neighbours sit at identical distances', () => {
    // The regression behind the closest-row bandwidth search. With `k` neighbours tied at one
    // distance, entropy cannot fall below `log k`, so a lower perplexity is unreachable and `beta`
    // climbs until `exp(-d·beta)` underflows. Reading that as "still too wide" left the row
    // uniform, which scrambles the map at every learning rate.
    const per = 20;
    const n = 60;
    const squared = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : Math.floor(i / per) === Math.floor(j / per) ? 0.04 : 1.44)),
    );
    // Perplexity 18 against 19 tied in-group neighbours — just under the reachable floor.
    const points = tsne(squared, { perplexity: 18, iterations: 400 });
    const d = (a: number, b: number) => Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y);
    let within = 0;
    let between = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.floor(i / per) === Math.floor(j / per)) within = Math.max(within, d(i, j));
        else between = Math.min(between, d(i, j));
      }
    }
    expect(within).toBeLessThan(between);
  });

  it('keeps identical points on the map rather than dropping them', () => {
    // Every distance equal: no bandwidth changes the entropy, so the rows go uniform.
    const squared = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => (i === j ? 0 : 0)));
    const points = tsne(squared, { iterations: 60 });
    expect(points).toHaveLength(4);
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});

describe('projectSessions', () => {
  /** Six sessions on two subjects, three each, run under a mix of commands. */
  function corpus(): ProjectableSession[] {
    const scroll = ['scroll', 'panel', 'artifact', 'overflow', 'viewport'];
    const cache = ['cache', 'token', 'prefix', 'breakpoint', 'ephemeral'];
    return [
      { id: 'aaaaaaaaaaaaaaa1', command: 'task', words: scroll },
      { id: 'aaaaaaaaaaaaaaa2', command: 'fb', words: scroll },
      { id: 'aaaaaaaaaaaaaaa3', command: 'task', words: scroll },
      { id: 'bbbbbbbbbbbbbbb1', command: 'god', words: cache },
      { id: 'bbbbbbbbbbbbbbb2', command: 'task', words: cache },
      { id: 'bbbbbbbbbbbbbbb3', command: null, words: cache },
    ].map(({ id, command, words }) =>
      session({
        threadId: id,
        title: words.slice(0, 2).join(' '),
        subtitle: command ? envelope(command, words.join(' ')) : words.join(' '),
        nodes: words.map((w, i) => node(`${w} ${words[(i + 1) % words.length]}`, i)),
      }),
    );
  }

  it('places same-subject sessions nearer each other than cross-subject ones', () => {
    const { points } = projectSessions(corpus(), { perplexity: 2, iterations: 400 });
    const at = (id: string) => points.find((p) => p.threadId === id)!;
    const gap = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    const within = Math.max(
      gap('aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2'),
      gap('aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa3'),
      gap('bbbbbbbbbbbbbbb1', 'bbbbbbbbbbbbbbb2'),
    );
    const across = Math.min(gap('aaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbb1'), gap('aaaaaaaaaaaaaaa2', 'bbbbbbbbbbbbbbb2'));
    expect(within).toBeLessThan(across);
  });

  it('labels each point with its command and ranks the legend, ordinary sessions last', () => {
    const { points, commands } = projectSessions(corpus(), { perplexity: 2, iterations: 60 });
    expect(points.find((p) => p.threadId === 'aaaaaaaaaaaaaaa1')?.command).toBe('task');
    expect(points.find((p) => p.threadId === 'bbbbbbbbbbbbbbb3')?.command).toBeNull();
    expect(commands[0]).toEqual({ command: 'task', sessions: 3 });
    expect(commands.at(-1)).toEqual({ command: null, sessions: 1 });
  });

  it('groups by subject rather than by command', () => {
    // The two subjects each span several commands, so a map clustering by command would put
    // the three `/task` runs together; clustering by subject splits them across the two groups.
    const { points } = projectSessions(corpus(), { perplexity: 2, iterations: 400 });
    const tasks = points.filter((p) => p.command === 'task');
    const spread = Math.max(...tasks.flatMap((a) => tasks.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    const scrollPair = points.filter((p) => p.threadId.startsWith('aaaa'));
    const tight = Math.max(...scrollPair.flatMap((a) => scrollPair.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    expect(tight).toBeLessThan(spread);
  });

  it('skips a session with no usable text instead of parking it at the origin', () => {
    const rows = [...corpus(), session({ threadId: 'cccccccccccccccc' })];
    const { points, meta } = projectSessions(rows, { perplexity: 2, iterations: 60 });
    expect(meta.skipped).toBe(1);
    expect(meta.sessions).toBe(6);
    expect(points.some((p) => p.threadId === 'cccccccccccccccc')).toBe(false);
  });

  it('names a command run by its criteria when the derived title is only the bare command', () => {
    // Real transcripts do this constantly: `deriveSessionName` keeps the first sentence of the
    // opening prompt, so a run whose args lead with flags or span several lines derives to just
    // `/task` — which repeats the dot's own colour and identifies nothing.
    const rows = [
      session({
        threadId: 'dddddddddddddddd',
        derivedTitle: '/task',
        subtitle: envelope(
          'task',
          '--add review --draft Rework the artifact panel scroll behaviour on narrow viewports',
        ),
        nodes: [node('scroll panel viewport')],
      }),
    ];
    const [point] = projectSessions(rows).points;
    expect(point?.command).toBe('task');
    // `--add` and `--draft` are dropped. `review` survives because it is `--add`'s *value* and
    // nothing here knows which flags take one — cosmetic in a name, not misleading.
    expect(point?.name).toBe('/task · review Rework the artifact panel scroll behaviour on narrow…');
  });

  it('keeps a derived title that already says more than the command', () => {
    const rows = [
      session({
        threadId: 'eeeeeeeeeeeeeeee',
        derivedTitle: '/teach me about red herrings',
        subtitle: envelope('teach', 'me about red herrings'),
        nodes: [node('herring debugging')],
      }),
    ];
    expect(projectSessions(rows).points[0]?.name).toBe('/teach me about red herrings');
  });

  it('prefers the CLI title over anything derived', () => {
    const rows = [
      session({
        threadId: 'ffffffffffffffff',
        title: 'Artifact panel scroll fix',
        derivedTitle: '/task',
        subtitle: envelope('task', '--draft fix the scroll'),
        nodes: [node('scroll panel')],
      }),
    ];
    expect(projectSessions(rows).points[0]?.name).toBe('Artifact panel scroll fix');
  });

  it('names every point and reports the terms that pinned it', () => {
    const { points } = projectSessions(corpus(), { perplexity: 2, iterations: 60 });
    for (const point of points) {
      expect(point.name).not.toBe('');
      expect(point.terms.length).toBeGreaterThan(0);
      expect(point.x).toBeGreaterThanOrEqual(-1);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(-1);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  it('carries the listing fields the tooltip shows', () => {
    const [point] = projectSessions(corpus(), { perplexity: 2, iterations: 60 }).points;
    expect(point).toMatchObject({ model: 'claude-opus-4-8', started: '2026-08-01T10:00:00.000Z', tools: 3 });
  });

  it('reports the clamped perplexity rather than the one asked for', () => {
    const { meta } = projectSessions(corpus(), { perplexity: 50, iterations: 60 });
    expect(meta.perplexity).toBeLessThan(50);
    expect(meta.sessions).toBe(6);
  });

  it('is empty for an empty corpus, and a single session sits at the origin', () => {
    expect(projectSessions([])).toMatchObject({ points: [], commands: [], meta: { sessions: 0, skipped: 0 } });
    const one = projectSessions([session({ subtitle: 'a lone session about caching' })]);
    expect(one.points).toHaveLength(1);
    expect(one.points[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('is reproducible across runs', () => {
    const a = projectSessions(corpus(), { perplexity: 2, iterations: 120 });
    const b = projectSessions(corpus(), { perplexity: 2, iterations: 120 });
    expect(a.points.map((p) => [p.threadId, p.x, p.y])).toEqual(b.points.map((p) => [p.threadId, p.x, p.y]));
  });
});
