import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConceptSearch } from '../src/api.js';
import { conceptStorePath } from '../src/concepts.js';
import { RemoteConceptStoreError } from '../src/concepts-remote.js';

/**
 * Searching the corpus by its prose.
 *
 * The point of the route is the text the Concepts table never renders — `notes`,
 * `tips`, `sources`, `surfacedSkills` — so most of what is asserted here is that a
 * query which appears in *only* those fields still finds its record, on both
 * backings. **The network is stubbed in every test**; nothing here may reach the
 * real Worker.
 */

const ORIGIN = 'https://operator.example.workers.dev';
const TOKEN = 'test-token-never-logged';
const SEARCH_URL = `${ORIGIN}/api/concepts/search`;
const EXPORT_URL = `${ORIGIN}/api/concepts/export`;

/**
 * Two records whose distinguishing words are all in the prose. Neither `term`,
 * `sentence`, `field` nor `skills` mentions "vestibular" or "idempotent" — the
 * table would show a reader nothing to scan for.
 */
const CORPUS = [
  {
    term: 'rubber-banding',
    sentence: 'Rubber-banding lets a list scroll past its end and spring back.',
    field: 'Motion',
    skills: ['apple-design'],
    savedAt: '2026-08-01T13:32:28.675Z',
    notes: 'Overscroll that resists further the further it goes. Users with vestibular sensitivity feel this one.',
    tips: ['Cap the stretch at a third of the viewport.'],
    sources: ['https://developer.apple.com/design/'],
  },
  {
    term: 'watermark',
    sentence: 'A watermark records how far a store was read so the next pass can skip it.',
    field: 'Ingestion',
    skills: ['sqlite'],
    savedAt: '2026-08-02T09:00:00.000Z',
    notes: 'Replaying from a watermark has to be idempotent, or a retry double-counts the window.',
    surfacedSkills: ['durable-objects'],
  },
];

const JSONL = CORPUS.map((record) => JSON.stringify(record)).join('\n');

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'concepts-search-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(logDir, { recursive: true, force: true });
});

function configureRemote(): void {
  vi.stubEnv('CONCEPTS_URL', ORIGIN);
  vi.stubEnv('CONCEPTS_TOKEN', TOKEN);
}

async function writeLocalStore(): Promise<void> {
  await writeFile(conceptStorePath(logDir), `${JSONL}\n`, 'utf8');
}

/**
 * A Worker that answers the export with the corpus and the search route with
 * whatever ranking a test names, recording every URL it was asked for.
 */
function stubWorker(hits: unknown[] | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = input instanceof URL ? input.toString() : input;
    if (url.startsWith(EXPORT_URL)) {
      return new Response(JSONL, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    if (hits instanceof Error) throw hits;
    return new Response(JSON.stringify({ results: hits, count: hits.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** One record as the store's search route sends it back: the whole record, plus a score. */
function hit(index: number, score: number) {
  return { ...CORPUS[index], id: `row-${index}`, score };
}

/** The URL the search request went to, with its query string intact. */
function searchRequest(fetchMock: ReturnType<typeof vi.fn>): URL {
  const call = fetchMock.mock.calls.find(([input]) => String(input).startsWith(SEARCH_URL));
  if (!call) throw new Error('no search request was issued');
  return new URL(String(call[0]));
}

describe('the hosted store answers the search', () => {
  it('ranks by what the store said, not by the corpus order', async () => {
    configureRemote();
    // The *older* record scores higher. Corpus order is newest first, so an
    // answer in corpus order would put `watermark` first and fail this.
    stubWorker([hit(0, 9.5), hit(1, 2.25)]);

    const { results, ranked } = await buildConceptSearch(logDir, 'scroll');
    expect(ranked).toBe(true);
    expect(results.map((r) => r.concept.term)).toEqual(['rubber-banding', 'watermark']);
    expect(results[0]?.score).toBe(9.5);
  });

  it('finds a record by a word that appears only in its notes', async () => {
    configureRemote();
    stubWorker([hit(0, 4)]);

    const { results } = await buildConceptSearch(logDir, 'vestibular');
    expect(results).toHaveLength(1);
    // The point of the feature: the match is in text the table does not render.
    expect(results[0]?.matchedIn).toEqual(['notes']);
    expect(results[0]?.excerpt).toContain('vestibular');
  });

  it('keeps the permalink: a hit carries the corpus `ord`, which the store never sends', async () => {
    configureRemote();
    stubWorker([hit(1, 3)]);

    const { results } = await buildConceptSearch(logDir, 'idempotent');
    // Line 1 of the export, so `/concepts/1` opens it.
    expect(results[0]?.concept.ord).toBe(1);
  });

  it('asks for every version and passes the bearer token', async () => {
    configureRemote();
    const fetchMock = stubWorker([]);

    await buildConceptSearch(logDir, 'watermark');
    const url = searchRequest(fetchMock);
    expect(url.searchParams.get('q')).toBe('watermark');
    // The page lists a term taught twice twice; the store's default would not.
    expect(url.searchParams.get('includeSuperseded')).toBe('true');

    const call = fetchMock.mock.calls.find(([input]) => String(input).startsWith(SEARCH_URL));
    // SAFETY: `call` was just found by `.find`, and every request `buildConceptSearch`
    // issues passes an init object as its second `fetch` argument.
    const init = call?.[1] as RequestInit;
    // SAFETY: `init` above is the `fetch` init `buildConceptSearch` built, which always
    // sets `headers` to a plain string-keyed record carrying the bearer token.
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('drops a ranked hit the corpus does not hold rather than inventing a row', async () => {
    configureRemote();
    stubWorker([{ term: 'ghost', savedAt: '2020-01-01T00:00:00.000Z', score: 99 }, hit(0, 1)]);

    const { results } = await buildConceptSearch(logDir, 'ghost');
    expect(results.map((r) => r.concept.term)).toEqual(['rubber-banding']);
  });

  it('never puts the token, or the query, in the answer', async () => {
    configureRemote();
    stubWorker([hit(0, 1)]);
    expect(JSON.stringify(await buildConceptSearch(logDir, 'vestibular'))).not.toContain(TOKEN);
  });

  it('fails loudly when the store will not answer, rather than reporting no matches', async () => {
    configureRemote();
    stubWorker(new TypeError('fetch failed'));
    await writeLocalStore();

    // A quiet `[]` here is indistinguishable from a corpus that holds nothing.
    await expect(buildConceptSearch(logDir, 'watermark')).rejects.toThrow(RemoteConceptStoreError);
  });

  it('names the search route in that failure without leaking the token or the query text', async () => {
    configureRemote();
    stubWorker(new TypeError('fetch failed'));

    const error = await buildConceptSearch(logDir, 'a-secret-thing').then(
      () => {
        throw new Error('the search resolved; it was supposed to fail');
      },
      // SAFETY: this rejection handler only ever runs on the `TypeError` `stubWorker`
      // throws above, via `buildConceptSearch`'s own rejection — never a non-Error value.
      (cause: unknown) => cause as Error,
    );
    expect(error.message).toContain(SEARCH_URL);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('a-secret-thing');
  });
});

describe('the local file, which has no ranked search', () => {
  it('says so rather than claiming a ranking it did not do', async () => {
    await writeLocalStore();
    const { ranked, meta } = await buildConceptSearch(logDir, 'watermark');
    expect(meta.store).toBe('local');
    expect(ranked).toBe(false);
  });

  it('still reaches the notes — the substring pass covers the same fields', async () => {
    await writeLocalStore();
    const { results } = await buildConceptSearch(logDir, 'idempotent');
    expect(results.map((r) => r.concept.term)).toEqual(['watermark']);
    expect(results[0]?.matchedIn).toEqual(['notes']);
    expect(results[0]?.excerpt).toContain('idempotent');
  });

  it('reaches tips, sources and surfaced skills too, and never reports a score', async () => {
    await writeLocalStore();
    const tips = await buildConceptSearch(logDir, 'viewport');
    expect(tips.results[0]?.matchedIn).toEqual(['tips']);
    expect(tips.results[0]?.score).toBeNull();

    expect((await buildConceptSearch(logDir, 'developer.apple.com')).results[0]?.matchedIn).toEqual(['sources']);
    expect((await buildConceptSearch(logDir, 'durable-objects')).results[0]?.matchedIn).toEqual(['surfacedSkills']);
  });

  it('requires every word, the way the store’s own query does', async () => {
    await writeLocalStore();
    // Both words are in the corpus, but never in one record.
    expect((await buildConceptSearch(logDir, 'vestibular idempotent')).results).toEqual([]);
    expect((await buildConceptSearch(logDir, 'watermark idempotent')).results).toHaveLength(1);
  });

  it('matches without regard to case', async () => {
    await writeLocalStore();
    expect((await buildConceptSearch(logDir, 'VESTIBULAR')).results).toHaveLength(1);
  });

  it('issues no request at all — a local backing has no store to ask', async () => {
    const fetchMock = stubWorker([hit(0, 1)]);
    await writeLocalStore();
    await buildConceptSearch(logDir, 'watermark');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('an empty query', () => {
  it.each([
    ['nothing at all', ''],
    ['only whitespace', '   '],
  ])('answers no results for %s, leaving the caller to show the corpus', async (_label, query) => {
    await writeLocalStore();
    const answer = await buildConceptSearch(logDir, query);
    expect(answer.results).toEqual([]);
    expect(answer.query).toBe('');
    // The corpus is still reported, so the page can say what it is not searching.
    expect(answer.meta.total).toBe(2);
  });

  it('asks the hosted store nothing', async () => {
    configureRemote();
    const fetchMock = stubWorker([hit(0, 1)]);
    await buildConceptSearch(logDir, '  ');
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith(SEARCH_URL))).toBe(false);
  });
});

describe('what the answer says about a match', () => {
  it('reports a match in a rendered column as such, and takes no excerpt from it', async () => {
    await writeLocalStore();
    const { results } = await buildConceptSearch(logDir, 'Ingestion');
    expect(results[0]?.matchedIn).toEqual(['field']);
    // The reader is already looking at the Field column; quoting it back says nothing.
    expect(results[0]?.excerpt).toBeNull();
  });

  it('elides a long excerpt at both ends rather than dumping the whole note', async () => {
    const filler = 'padding words to push the match into the middle of a long note. '.repeat(8);
    await writeFile(
      conceptStorePath(logDir),
      `${JSON.stringify({ ...CORPUS[0], notes: `${filler}vestibular${filler}` })}\n`,
      'utf8',
    );

    const excerpt = (await buildConceptSearch(logDir, 'vestibular')).results[0]?.excerpt ?? '';
    expect(excerpt).toContain('vestibular');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    // A window, not the note: the note here is over a thousand characters.
    expect(excerpt.length).toBeLessThan(250);
  });

  it('keeps a short note whole, with no elision to suggest text was cut', async () => {
    await writeLocalStore();
    const excerpt = (await buildConceptSearch(logDir, 'sensitivity')).results[0]?.excerpt ?? '';
    expect(excerpt).toContain('sensitivity');
    expect(excerpt.startsWith('…')).toBe(false);
    expect(excerpt.endsWith('…')).toBe(false);
  });

  it('serves the meta-skill filter exactly as the list route does', async () => {
    await writeFile(
      conceptStorePath(logDir),
      `${JSON.stringify({ ...CORPUS[0], skills: ['find-skills', 'apple-design'] })}\n`,
      'utf8',
    );
    const { results } = await buildConceptSearch(logDir, 'rubber-banding');
    expect(results[0]?.concept.skills).toEqual(['apple-design']);
  });
});
