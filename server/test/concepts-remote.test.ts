import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConcept, buildConcepts } from '../src/api.js';
import { conceptStorePath } from '../src/concepts.js';
import { RemoteConceptStoreError } from '../src/concepts-remote.js';
import { PARITY_ROUTES } from '../src/parity.js';

/**
 * The hosted store answers when it is configured, the local file when it is not,
 * and the answer always says which. **The network is stubbed in every test
 * here** — nothing in this file may reach the real Worker.
 */

const ORIGIN = 'https://operator.example.workers.dev';
const TOKEN = 'test-token-never-logged';
const EXPORT_URL = `${ORIGIN}/api/concepts/export`;

/** Two records in the export's own order: oldest first, as the file was written. */
const CORPUS = [
  {
    term: 'carousel',
    sentence: 'A carousel shows one image at a time and dims its neighbours.',
    field: 'UI component vocabulary',
    skills: ['animation-vocabulary', 'find-skills'],
    savedAt: '2026-08-01T13:32:28.675Z',
  },
  {
    term: 'watermark',
    sentence: 'A watermark records how far a store was read so the next pass can skip it.',
    field: 'Ingestion',
    skills: ['sqlite'],
    savedAt: '2026-08-02T09:00:00.000Z',
  },
];

const JSONL = CORPUS.map((record) => JSON.stringify(record)).join('\n');

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'concepts-remote-'));
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

/**
 * A stub standing in for the Worker, recording what was asked of it.
 *
 * A fresh `Response` per call, because a body may only be read once and the
 * permalink test reads the store twice.
 */
function stubWorker(reply: (() => Response) | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ndjson(body: string, status = 200): () => Response {
  return () => new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

/**
 * The error a read rejected with, typed as an `Error` — awaiting a `.catch()`
 * widens to a union with no `message` to assert against.
 */
function rejection(read: Promise<unknown>): Promise<Error> {
  return read.then(
    () => {
      throw new Error('the read resolved, and this test needs it to reject');
    },
    (err: unknown) => err as Error,
  );
}

describe('the hosted store, when both variables are set', () => {
  it('answers the list, over the export route, with the bearer token', async () => {
    configureRemote();
    const fetchMock = stubWorker(ndjson(JSONL));

    const { concepts, meta } = await buildConcepts(logDir);

    expect(concepts.map((c) => c.term)).toEqual(['watermark', 'carousel']);
    expect(meta.store).toBe('remote');
    expect(meta.storePath).toBe(EXPORT_URL);
    expect(meta.total).toBe(2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXPORT_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('is read instead of the local file, not alongside it', async () => {
    // A local store that says something different proves which one answered.
    await writeFile(
      conceptStorePath(logDir),
      `${JSON.stringify({ ...CORPUS[0], term: 'local-only', savedAt: '2026-08-09T00:00:00.000Z' })}\n`,
      'utf8',
    );
    configureRemote();
    stubWorker(ndjson(JSONL));

    const { concepts } = await buildConcepts(logDir);
    expect(concepts.map((c) => c.term)).toEqual(['watermark', 'carousel']);
  });

  it('serves the meta-skill filter and the optional fields exactly as the file path does', async () => {
    configureRemote();
    stubWorker(
      ndjson(
        JSON.stringify({
          ...CORPUS[0],
          skills: ['find-skills', 'animation-vocabulary'],
          surfacedSkills: ['find-skills', 'radix-primitives'],
        }),
      ),
    );

    const { concepts } = await buildConcepts(logDir);
    expect(concepts[0]?.skills).toEqual(['animation-vocabulary']);
    expect(concepts[0]?.surfacedSkills).toEqual(['radix-primitives']);
  });

  it('never puts the token in the answer', async () => {
    configureRemote();
    stubWorker(ndjson(JSONL));
    expect(JSON.stringify(await buildConcepts(logDir))).not.toContain(TOKEN);
  });

  it('keeps a permalink resolving: `ord` is the export line, not the row id', async () => {
    configureRemote();
    stubWorker(ndjson(JSONL));

    // Line 0 of the export is line 0 of `logs/concepts.jsonl`, so `/concepts/0`
    // still opens the same concept.
    const { concept, meta } = await buildConcept(logDir, 0);
    expect(concept.term).toBe('carousel');
    expect(meta.store).toBe('remote');
    expect(meta.total).toBe(2);

    // And the newest record, first on the page, is still the *last* line.
    expect((await buildConcept(logDir, 1)).concept.term).toBe('watermark');
  });

  it('still 404s a line the corpus does not hold', async () => {
    configureRemote();
    stubWorker(ndjson(JSONL));
    await expect(buildConcept(logDir, 9)).rejects.toThrow('concept not found: 9');
  });
});

describe('the local file, when a variable is missing', () => {
  it('answers unchanged, and says why it was the one that answered', async () => {
    const fetchMock = stubWorker(ndjson(JSONL));
    await writeFile(conceptStorePath(logDir), `${JSONL}\n`, 'utf8');

    const { concepts, meta } = await buildConcepts(logDir);
    expect(concepts.map((c) => c.term)).toEqual(['watermark', 'carousel']);
    expect(meta.store).toBe('local');
    expect(meta.storePath).toContain(conceptStorePath(logDir));
    // The half that stops an empty page being read as an empty corpus.
    expect(meta.storePath).toContain('CONCEPTS_URL/CONCEPTS_TOKEN unset');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders an empty page rather than erroring on a checkout with no store at all', async () => {
    stubWorker(ndjson(JSONL));
    const { concepts, meta } = await buildConcepts(logDir);
    expect(concepts).toEqual([]);
    expect(meta.store).toBe('local');
  });

  it.each([
    ['only the URL', { CONCEPTS_URL: ORIGIN, CONCEPTS_TOKEN: '' }],
    ['only the token', { CONCEPTS_URL: '', CONCEPTS_TOKEN: TOKEN }],
  ])('falls back when there is %s — half a credential reads nothing', async (_label, env) => {
    vi.stubEnv('CONCEPTS_URL', env.CONCEPTS_URL);
    vi.stubEnv('CONCEPTS_TOKEN', env.CONCEPTS_TOKEN);
    const fetchMock = stubWorker(ndjson(JSONL));

    expect((await buildConcepts(logDir)).meta.store).toBe('local');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the parity harness', () => {
  const conceptRoutes = () => PARITY_ROUTES.filter((route) => route.name.startsWith('/api/concepts'));

  it('enumerates its concepts cases against the local file', async () => {
    await writeFile(conceptStorePath(logDir), `${JSONL}\n`, 'utf8');
    const counts = await Promise.all(
      conceptRoutes().map(async (route) => (await route.cases({ logDir, limits: {} })).length),
    );
    expect(counts).toEqual([1, 2]);
  });

  it('enumerates nothing once the hosted store is configured', async () => {
    await writeFile(conceptStorePath(logDir), `${JSONL}\n`, 'utf8');
    configureRemote();
    const fetchMock = stubWorker(ndjson(JSONL));

    for (const route of conceptRoutes()) {
      expect(await route.cases({ logDir, limits: {} })).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a hosted store that will not answer', () => {
  it('fails loudly on a non-2xx rather than serving the other store', async () => {
    configureRemote();
    stubWorker(ndjson('{"error":"unauthorized"}', 401));
    // A local store exists and is deliberately not what the caller gets.
    await writeFile(conceptStorePath(logDir), `${JSONL}\n`, 'utf8');

    await expect(buildConcepts(logDir)).rejects.toThrow(RemoteConceptStoreError);
    await expect(buildConcepts(logDir)).rejects.toThrow(`${EXPORT_URL} answered 401`);
  });

  it('reports a 500 from the Worker the same way', async () => {
    configureRemote();
    stubWorker(ndjson('boom', 500));
    await expect(buildConcept(logDir, 0)).rejects.toThrow('concept store unreachable');
  });

  it('reports a refused connection without leaking the token', async () => {
    configureRemote();
    stubWorker(new TypeError('fetch failed'));

    const error = await rejection(buildConcepts(logDir));
    expect(error).toBeInstanceOf(RemoteConceptStoreError);
    expect(error.message).toContain('fetch failed');
    expect(error.message).toContain(EXPORT_URL);
    expect(error.message).not.toContain(TOKEN);
  });

  it('names the URL it actually requested when the configured URL carries a path prefix', async () => {
    vi.stubEnv('CONCEPTS_URL', `${ORIGIN}/concepts`);
    vi.stubEnv('CONCEPTS_TOKEN', TOKEN);
    const fetchMock = stubWorker(ndjson('nope', 503));

    const error = await rejection(buildConcepts(logDir));
    const [requested] = fetchMock.mock.calls[0] as [string];
    expect(requested).toBe(`${ORIGIN}/concepts/api/concepts/export`);
    expect(error.message).toContain(requested);
  });

  it('names the store by origin and path only, so a credential in the URL cannot leak', async () => {
    vi.stubEnv('CONCEPTS_URL', `https://user:${TOKEN}@operator.example.workers.dev`);
    vi.stubEnv('CONCEPTS_TOKEN', TOKEN);
    stubWorker(ndjson('nope', 503));

    const error = await rejection(buildConcepts(logDir));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain(EXPORT_URL);
  });
});
