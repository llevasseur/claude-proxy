// The bundle is read-only input that may not be there at all, so these drive the
// reader over a synthetic bundle on disk plus the paths where there is nothing to
// read — an absent install is an empty page, never a throw.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCliFunction, buildCliInternals } from '../src/api.js';
import { readCliCatalogue, readCliFunctionSource, resetCliCatalogueCache } from '../src/cli-bundle.js';

/**
 * A stand-in bundle: leading bytes that are not code — the shape a compiled
 * executable's data section presents — then the functions two catalogue rows
 * are keyed to.
 */
const TRUTHY = 'function tr(e){let t=String(e).toLowerCase().trim();return["1","true","yes","on"].includes(t)}';
const FALSY = 'function ud(e){let t=String(e).toLowerCase().trim();return["0","false","no","off"].includes(t)}';
const BUNDLE = `\0\0["1","true","yes","on"]\0\0${TRUTHY}${FALSY}`;

async function writeBundle(contents = BUNDLE): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-bundle-'));
  const file = path.join(dir, '9.9.9');
  await writeFile(file, contents, 'latin1');
  return file;
}

beforeEach(() => {
  // The reader caches one resolution; without this a test would see the last one's.
  resetCliCatalogueCache();
});

describe('readCliCatalogue', () => {
  it('resolves against a bundle on disk and reports its version', async () => {
    const bundlePath = await writeBundle();
    const { bundle, functions } = await readCliCatalogue(bundlePath);

    expect(bundle).toMatchObject({ path: bundlePath, version: '9.9.9', exists: true, error: null });
    expect(bundle.bytes).toBe(BUNDLE.length);
    expect(functions.find((f) => f.id === 'env-truthy')?.name).toBe('tr');
    expect(functions.find((f) => f.id === 'env-explicitly-false')?.name).toBe('ud');
  });

  it('skips the data-section occurrence and offsets into the real function', async () => {
    const bundlePath = await writeBundle();
    const { functions } = await readCliCatalogue(bundlePath);
    const entry = functions.find((f) => f.id === 'env-truthy');

    expect(entry?.offset).toBe(BUNDLE.indexOf(TRUTHY));
    expect(await readCliFunctionSource(entry!, bundlePath)).toBe(TRUTHY);
  });

  it('marks every row missing when the bundle carries none of the signals', async () => {
    const bundlePath = await writeBundle('nothing resembling the claude code bundle');
    const { bundle, functions } = await readCliCatalogue(bundlePath);

    expect(bundle.error).toBeNull();
    expect(functions.every((f) => f.missing !== null && f.offset === null)).toBe(true);
  });

  it('reports an absent bundle as an empty state rather than throwing', async () => {
    const { bundle, functions } = await readCliCatalogue('/nonexistent/claude/versions/1.0.0');

    expect(bundle.exists).toBe(false);
    expect(bundle.error).toMatch(/could not be read/);
    expect(functions).toEqual([]);
  });

  it('reports having found no install at all', async () => {
    const { bundle, functions } = await readCliCatalogue(null);

    expect(bundle).toMatchObject({ path: null, version: null, exists: false });
    expect(bundle.error).toMatch(/No Claude Code install/);
    expect(functions).toEqual([]);
  });

  it('reports a directory as unreadable rather than parsing it', async () => {
    const bundlePath = await writeBundle();
    const { bundle } = await readCliCatalogue(path.dirname(bundlePath));

    expect(bundle.error).toBe('Bundle path is not a file.');
  });

  it('serves a second read of the same bundle from cache', async () => {
    const bundlePath = await writeBundle();
    const first = await readCliCatalogue(bundlePath);
    const second = await readCliCatalogue(bundlePath);

    expect(first.durationMs).not.toBeNull();
    expect(second.durationMs).toBeNull();
    expect(second.functions).toEqual(first.functions);
  });
});

describe('readCliFunctionSource', () => {
  it('returns null for a row that never resolved', async () => {
    const bundlePath = await writeBundle();
    const { functions } = await readCliCatalogue(bundlePath);
    const missing = functions.find((f) => f.missing !== null);

    expect(await readCliFunctionSource(missing!, bundlePath)).toBeNull();
  });
});

describe('buildCliInternals and buildCliFunction', () => {
  it('counts what resolved against this version', async () => {
    const bundlePath = await writeBundle();
    const res = await buildCliInternals(bundlePath);

    expect(res.meta.resolved).toBe(2);
    expect(res.meta.missing).toBe(res.functions.length - 2);
    expect(res.bundle.version).toBe('9.9.9');
  });

  it('serves one function with its source', async () => {
    const bundlePath = await writeBundle();
    const res = await buildCliFunction('env-truthy', bundlePath);

    expect(res.function.signature).toBe('tr(e)');
    expect(res.source).toBe(TRUTHY);
  });

  it('serves a catalogued but unresolved function as a null source, not an error', async () => {
    const bundlePath = await writeBundle();
    const res = await buildCliFunction('agent-summary-prompt', bundlePath);

    expect(res.function.missing).toBe('signal-missing');
    expect(res.source).toBeNull();
  });

  it('throws the labelled error the server maps to 404 for an unknown id', async () => {
    const bundlePath = await writeBundle();

    await expect(buildCliFunction('no-such-row', bundlePath)).rejects.toThrow('cli function not found');
  });
});
