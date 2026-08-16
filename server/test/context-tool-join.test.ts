// `/api/context` reads `request.toolCount` and nothing else about tools, but the
// substrate was fetching every tool schema of every request in the window to build
// an array the route never opened — 1,360,639 `request_tool` rows for the 41,621
// requests a 30-day window holds on this device. `omitTools` drops that fetch. What
// has to hold is that the answer does not move, that the emptied array is still an
// *array* (`isAuditSidecar` requires one, and a missing key would delete the whole
// window from the response), and that both backings honour the flag identically —
// `/api/context` is compared byte-for-byte across the two.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isAuditSidecar } from '@claude-proxy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/api.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource, readWindow } from '../src/db/source.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const SESSION = '0f0b7a02-1f4a-4a1d-9d34-9f6b1c2d3e40';
/** The day the archived half sits under, one reporting day behind the live half. */
const ARCHIVED_DAY = '2026-07-27';

let logDir: string;
let db: DatabaseSync;

const sidecar = (minute: string, threadId: string, tools: number) => ({
  timestamp: `2026-07-29T09:${minute}:00.000Z`,
  model: 'claude-opus-5',
  session: { sessionId: SESSION, threadId },
  tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, realInput: 1000 },
  request: { toolCount: tools, toolsBytes: 100 * tools, systemBytes: 200, totalBytes: 3000 },
  tools: Array.from({ length: tools }, (_, i) => ({ name: `tool_${i}`, bytes: 100, estTokens: 25 })),
});

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-tool-join-'));
  for (let i = 0; i < 4; i += 1) {
    const minute = String(i).padStart(2, '0');
    await writeFile(
      path.join(logDir, `2026-07-29T09-${minute}-00-000Z_anthropic.audit.json`),
      JSON.stringify(sidecar(minute, `bbbb0000bbbb000${i + 1}`, i + 1)),
    );
  }

  // The archived half goes through `readWholeArchive`, which issues the same
  // clause once for every day — the second caller of the query being changed.
  const archived = path.join(logDir, 'archive', ARCHIVED_DAY);
  await mkdir(archived, { recursive: true });
  await writeFile(
    path.join(archived, `${ARCHIVED_DAY}T09-00-00-000Z_anthropic.audit.json`),
    JSON.stringify({
      ...sidecar('00', 'bbbb0000bbbb0009', 3),
      timestamp: `${ARCHIVED_DAY}T09:00:00.000Z`,
    }),
  );

  db = openDb(logDir);
  await ingest(db, logDir);
});

afterAll(() => {
  db.close();
});

const sources = () => [['files', fileSource] as const, ['db', dbSource(db)] as const];

describe('the context window read skipping the tool join', () => {
  it('empties the tool list on both backings, and empties it the same way', async () => {
    for (const [kind, source] of sources()) {
      const { sidecars } = await readWindow(logDir, { sinceDays: 7, omitTools: true }, NOW, source);

      expect(sidecars.length, kind).toBeGreaterThan(0);
      for (const s of sidecars) {
        expect((s as { tools: unknown[] }).tools, kind).toEqual([]);
      }
    }
  });

  it('leaves the array in place, so the structural guard still passes', async () => {
    // A dropped key rather than an emptied array would fail `isAuditSidecar` and
    // silently delete every request in the window from the response.
    for (const [kind, source] of sources()) {
      const { sidecars } = await readWindow(logDir, { sinceDays: 7, omitTools: true }, NOW, source);

      for (const s of sidecars) {
        expect('tools' in (s as object), kind).toBe(true);
        expect(isAuditSidecar(s), kind).toBe(true);
      }
    }
  });

  it('is opt-in — an ordinary read still carries every tool schema', async () => {
    for (const [kind, source] of sources()) {
      const { sidecars } = await readWindow(logDir, { sinceDays: 7 }, NOW, source);
      const counts = sidecars.map((s) => (s as { tools: unknown[] }).tools.length).sort();

      // Four live requests plus the archived one, which carries three tools.
      expect(counts, kind).toEqual([1, 2, 3, 3, 4]);
      expect((sidecars[0] as { tools: Array<{ name: string }> }).tools[0]?.name, kind).toBe('tool_0');
    }
  });

  it('honours the flag on the archived half too, which is read by its own query', async () => {
    for (const [kind, source] of sources()) {
      const withTools = await readWindow(logDir, { all: true }, NOW, source);
      const without = await readWindow(logDir, { all: true, omitTools: true }, NOW, source);

      expect(withTools.files, kind).toBe(5);
      expect(without.files, kind).toBe(5);
      expect(
        withTools.sidecars.some((s) => (s as { tools: unknown[] }).tools.length === 3),
        kind,
      ).toBe(true);
      expect(
        without.sidecars.every((s) => (s as { tools: unknown[] }).tools.length === 0),
        kind,
      ).toBe(true);
    }
  });

  it('does not move the answer /api/context gives, on either backing', async () => {
    const fromFiles = await buildContext(logDir, 7, NOW, fileSource);
    const fromDb = await buildContext(logDir, 7, NOW, dbSource(db));

    // The two backings still agree byte for byte — the parity harness's whole claim.
    expect(fromDb).toEqual(fromFiles);
    // Four live threads plus the archived one, which the window reaches back to.
    expect(fromFiles.page.total).toBe(5);
    expect(fromFiles.summary.requestCount).toBe(5);
    // The sizes the page does draw come off the request row, not the joined list.
    expect(fromFiles.page.rows.map((r) => r.toolsBytes).sort((a, b) => a - b)).toEqual([100, 200, 300, 300, 400]);
  });
});
