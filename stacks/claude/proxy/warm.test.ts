/**
 * Unit tests for the keep-alive wiring: the loopback-only control endpoint, the
 * pending-to-armed handshake, the capture, and the `warm.json` status mirror.
 *
 * Run:  node --test stacks/claude/proxy/warm.test.ts
 *
 * `warm.json` is a brand-new artifact, so it inherits the obligation
 * [ADR 0019](../../../docs/adrs/0019-sanitized-audit-sidecars.md) puts on every artifact
 * this proxy writes: a test has to prove that a distinctive body marker and a
 * distinctive secret marker never reach it. The registry holds both in memory — a
 * stored body, stored headers, a borrowed bearer — so that proof is the whole point
 * rather than a formality.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { JsonObject, JsonValue } from './json.ts';
import {
  _resetKeepalive,
  DEFAULT_CACHE_TTL_MS,
  PENDING_TTL_MS,
  register,
  setBearerSource,
  setPingTransport,
  snapshot,
  sweepOnce,
} from './keepalive.ts';
import {
  _resetWarmStatus,
  CACHE_READ_METERING_WEIGHT,
  extractSession,
  isLoopbackAddress,
  isWarmControlPath,
  noteWarmRequest,
  WARM_STATUS_FILE,
  warmControl,
  warmSessionKey,
  warmStatusDocument,
  writeWarmStatus,
} from './proxy.ts';
import { bearerForAccount, hasAuth, noteAuth, resetAuth } from './usage-live.ts';
import type { HeaderBag, RequestBody } from './wire.ts';

const LOOPBACK = '127.0.0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Markers distinctive enough that finding either one anywhere is unambiguous. */
const BODY_MARKER = 'DISTINCTIVE_BODY_MARKER_9f3a2b';
const SECRET_MARKER = 'DISTINCTIVE_SECRET_MARKER_7c41de';

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));

function reset(): void {
  _resetKeepalive();
  _resetWarmStatus();
  resetAuth();
}

/** A control call from the loopback address, as `handle()` would hand one over. */
const call = (method: string, body?: JsonValue, options: { remoteAddress?: string; url?: string } = {}) =>
  warmControl({
    method,
    url: options.url ?? '/__warm',
    remoteAddress: options.remoteAddress ?? LOOPBACK,
    body: body === undefined ? '' : JSON.stringify(body),
  });

type Row = Record<string, JsonValue | undefined>;

/** The document's entries, as rows a test can read fields off. */
function rowsOf(doc: JsonObject): Row[] {
  // SAFETY: `warmStatusDocument` builds `entries` as an array of plain objects.
  return Array.isArray(doc.entries) ? (doc.entries as Row[]) : [];
}

/** The document's aggregate block. */
function totalsOf(doc: JsonObject): Row {
  // SAFETY: `warmStatusDocument` always builds `totals` as a plain object.
  return (doc.totals ?? {}) as Row;
}

/** A forwarded body shaped like a real request, with nothing distinctive in it. */
const plainBody = (): RequestBody => ({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });

// ------------------------------------------------------------ the loopback boundary

test('the control endpoint refuses a caller that is not on loopback', () => {
  reset();
  const reply = call('POST', { sessionId: 'sess-1', hours: 2 }, { remoteAddress: '203.0.113.9' });

  assert.equal(reply.statusCode, 403);
  assert.match(String(reply.payload.error), /loopback/);
  assert.equal(reply.changed, false);
  // The refusal lands before the registry is touched at all.
  assert.deepEqual(snapshot(), []);
});

test('a non-loopback caller cannot list entries either', () => {
  reset();
  call('POST', { sessionId: 'sess-1', hours: 2 });
  const reply = call('GET', undefined, { remoteAddress: '10.0.0.4' });

  assert.equal(reply.statusCode, 403);
  assert.equal(JSON.stringify(reply.payload).includes('sess-1'), false);
});

test('the loopback rule reads the peer address, whatever HOST was set to', () => {
  // `HOST=""` binds every interface; this endpoint must not follow it out there.
  for (const address of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, `${address} should be loopback`);
  }
  for (const address of ['203.0.113.9', '10.0.0.4', '192.168.1.20', '::ffff:10.0.0.4', '', null, undefined]) {
    assert.equal(isLoopbackAddress(address), false, `${String(address)} should not be loopback`);
  }
});

test('the control path is recognised with a query string, and nothing else is', () => {
  assert.equal(isWarmControlPath('/__warm'), true);
  assert.equal(isWarmControlPath('/__warm?sessionId=sess-1'), true);
  assert.equal(isWarmControlPath('/v1/messages'), false);
  assert.equal(isWarmControlPath('/v1/messages/count_tokens'), false);
  assert.equal(isWarmControlPath('/__warmish'), false);
});

// ------------------------------------------------------------------- registration

test('POST honours hours far above the old eight-hour ceiling', () => {
  reset();
  const reply = call('POST', { sessionId: 'sess-1', hours: 40 });

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.hours, 40);
  assert.equal(reply.payload.requestedHours, 40, 'requestedHours and hours are now always equal');
  const entry = snapshot()[0];
  assert.ok(entry);
  assert.equal(entry.deadline - entry.registeredAt, 40 * 3_600_000, 'the deadline honours the request verbatim');
});

test('POST keeps a duration it can honour, and refuses one it cannot', () => {
  reset();
  assert.equal(call('POST', { sessionId: 'sess-1', hours: 2 }).payload.hours, 2);

  reset();
  assert.equal(call('POST', { sessionId: 'sess-1', hours: 0 }).statusCode, 400);
  assert.equal(call('POST', { sessionId: 'sess-1', hours: -3 }).statusCode, 400);
  assert.equal(call('POST', { hours: 2 }).statusCode, 400);
  assert.deepEqual(snapshot(), [], 'a refused registration registers nothing');
});

test('a new registration is pending, never armed on its own say-so', () => {
  reset();
  const reply = call('POST', { sessionId: 'sess-1', hours: 2 });

  // The `/warm` command names a session id this proxy has not joined to the ids it sees
  // on the wire, so registration is a handshake rather than an assertion. See ADR 0075.
  assert.equal(reply.payload.state, 'pending');
  assert.equal(snapshot()[0]?.state, 'pending');
});

// ---------------------------------------------------------------- the handshake

test('a pending registration arms on a matching header session id', () => {
  reset();
  call('POST', { sessionId: 'sess-header', hours: 1 });
  assert.equal(snapshot()[0]?.state, 'pending');

  const headers: HeaderBag = { 'x-claude-code-session-id': 'sess-header' };
  const body = plainBody();
  const sender = extractSession(headers, body);
  assert.equal(warmSessionKey(sender), 'sess-header');

  const took = noteWarmRequest({
    sessionKey: warmSessionKey(sender),
    account: sender.account,
    reqJson: body,
    headers,
    startedAt: Date.now(),
  });

  assert.equal(took, true);
  assert.equal(snapshot()[0]?.state, 'armed');
});

test('a pending registration arms on a matching metadata session id', () => {
  reset();
  call('POST', { sessionId: 'sess-meta', hours: 1 });

  // No header at all — the id reaches the proxy only inside `metadata.user_id`.
  const headers: HeaderBag = {};
  const body: RequestBody = {
    ...plainBody(),
    metadata: { user_id: JSON.stringify({ account_uuid: 'acc-1', session_id: 'sess-meta' }) },
  };
  const sender = extractSession(headers, body);
  assert.equal(sender.sessionId, null, 'nothing came from a header');
  assert.equal(warmSessionKey(sender), 'sess-meta');

  const took = noteWarmRequest({
    sessionKey: warmSessionKey(sender),
    account: sender.account,
    reqJson: body,
    headers,
    startedAt: Date.now(),
  });

  assert.equal(took, true);
  const entry = snapshot()[0];
  assert.equal(entry?.state, 'armed');
  assert.equal(entry?.account, 'acc-1', 'the account comes with it, since it scopes the bearer');
});

test('an unregistered session stores nothing at all', () => {
  reset();
  const took = noteWarmRequest({
    sessionKey: 'nobody-registered-me',
    account: 'acc-1',
    reqJson: plainBody(),
    headers: { 'x-claude-code-session-id': 'nobody-registered-me' },
    startedAt: Date.now(),
  });

  assert.equal(took, false);
  assert.deepEqual(snapshot(), [], 'the feature stays off the hot path for everyone who never asked');
});

test('a registration nobody matched expires, with the reason reported', async () => {
  reset();
  const now = Date.now();
  register({ sessionKey: 'sess-ghost', hours: 4, now });

  await sweepOnce(now + PENDING_TTL_MS - 1_000);
  assert.equal(snapshot()[0]?.state, 'pending', 'still inside the two-minute window');

  await sweepOnce(now + PENDING_TTL_MS + 1_000);
  const entry = snapshot()[0];
  assert.equal(entry?.state, 'stopped');
  assert.equal(entry?.outcome?.reason, 'unmatched');

  // It never sits silently warming nothing: the mirror reports the expiry.
  assert.equal(rowsOf(warmStatusDocument())[0]?.outcome, 'expired');
});

// ----------------------------------------------------------------- cancel and list

test('DELETE cancels a registration and says whether it did', () => {
  reset();
  call('POST', { sessionId: 'sess-1', hours: 1 });

  const reply = call('DELETE', { sessionId: 'sess-1' });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.released, true);
  assert.equal(reply.changed, true);
  assert.equal(snapshot()[0]?.outcome?.reason, 'released');
  assert.equal(rowsOf(warmStatusDocument())[0]?.outcome, 'stopped-released');

  assert.equal(call('DELETE', { sessionId: 'sess-1' }).payload.released, false, 'a second cancel changes nothing');
});

test('DELETE reads the session id off the query string too', () => {
  reset();
  call('POST', { sessionId: 'sess-q', hours: 1 });
  const reply = warmControl({ method: 'DELETE', url: '/__warm?sessionId=sess-q', remoteAddress: LOOPBACK, body: '' });

  assert.equal(reply.payload.released, true);
});

test('GET lists the entries and never echoes a stored body or credential', () => {
  reset();
  call('POST', { sessionId: 'sess-1', hours: 1 });
  noteWarmRequest({
    sessionKey: 'sess-1',
    account: 'acc-1',
    reqJson: { ...plainBody(), messages: [{ role: 'user', content: BODY_MARKER }] },
    headers: { 'x-claude-code-session-id': 'sess-1', authorization: `Bearer ${SECRET_MARKER}` },
    startedAt: Date.now(),
  });

  const reply = call('GET');
  assert.equal(reply.statusCode, 200);
  const serialized = JSON.stringify(reply.payload);
  assert.equal(serialized.includes(BODY_MARKER), false);
  assert.equal(serialized.includes(SECRET_MARKER), false);
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(rowsOf(reply.payload)[0]?.sessionKey, 'sess-1');
  assert.equal(rowsOf(reply.payload)[0]?.state, 'armed');
});

test('an unsupported method is refused rather than guessed at', () => {
  reset();
  assert.equal(call('PUT', { sessionId: 'sess-1' }).statusCode, 405);
});

// ------------------------------------------------------------------ the status file

test('warm.json carries status only — never a body, a prompt, or a credential', () => {
  reset();
  const dir = tmpDir();
  call('POST', { sessionId: 'sess-secret', hours: 3 });

  // Everything a real request carries that must not reach the artifact. The registry
  // genuinely holds the body and the headers in memory, so this proves the document is
  // clean by construction rather than because nothing was there to leak.
  const headers: HeaderBag = {
    'x-claude-code-session-id': 'sess-secret',
    authorization: `Bearer ${SECRET_MARKER}`,
    'x-api-key': SECRET_MARKER,
    cookie: `session=${SECRET_MARKER}`,
  };
  const body: RequestBody = {
    model: 'claude-opus-5',
    system: [{ type: 'text', text: `system prompt ${BODY_MARKER}` }],
    tools: [{ name: 'Read', description: BODY_MARKER }],
    messages: [{ role: 'user', content: [{ type: 'text', text: BODY_MARKER }] }],
    metadata: { user_id: JSON.stringify({ account_uuid: 'acc-1', session_id: 'sess-secret' }) },
  };
  noteWarmRequest({ sessionKey: 'sess-secret', account: 'acc-1', reqJson: body, headers, startedAt: Date.now() });

  assert.equal(writeWarmStatus(dir), true);
  const raw = fs.readFileSync(path.join(dir, WARM_STATUS_FILE), 'utf8');

  assert.equal(raw.includes(BODY_MARKER), false, 'no body, prompt, or tool text may reach warm.json');
  assert.equal(raw.includes(SECRET_MARKER), false, 'no credential may reach warm.json');
  assert.equal(raw.includes('Bearer'), false);
  assert.equal(/"(messages|system|tools|headers|authorization|cookie|body)"/.test(raw), false);

  // And the status it is for is there.
  const doc: JsonObject = JSON.parse(raw);
  assert.equal(rowsOf(doc)[0]?.sessionKey, 'sess-secret');
  assert.equal(rowsOf(doc)[0]?.state, 'armed');
});

test('the mirror is written atomically and leaves no .tmp behind', () => {
  reset();
  const dir = tmpDir();
  call('POST', { sessionId: 'sess-1', hours: 1 });

  assert.equal(writeWarmStatus(dir), true);
  assert.equal(fs.existsSync(path.join(dir, WARM_STATUS_FILE)), true);
  assert.equal(fs.existsSync(path.join(dir, `${WARM_STATUS_FILE}.tmp`)), false);
});

test('nothing is written for a proxy nobody ever registered a session with', () => {
  reset();
  const dir = tmpDir();

  assert.equal(writeWarmStatus(dir), false);
  assert.equal(fs.existsSync(path.join(dir, WARM_STATUS_FILE)), false, 'the feature leaves no trace');
});

test('usageUnits is the cache-read count at the metering weight', async () => {
  reset();
  const now = Date.now();
  register({ sessionKey: 'sess-1', hours: 4, now });
  noteWarmRequest({ sessionKey: 'sess-1', account: 'acc-1', reqJson: plainBody(), headers: {}, startedAt: now });

  setBearerSource(() => 'Bearer live');
  setPingTransport(async () => ({ statusCode: 200, cacheReadTokens: 120_000 }));
  await sweepOnce(now + DEFAULT_CACHE_TTL_MS);

  const doc = warmStatusDocument();
  assert.equal(rowsOf(doc)[0]?.pingsSent, 1);
  assert.equal(rowsOf(doc)[0]?.cacheReadTokens, 120_000);
  assert.equal(rowsOf(doc)[0]?.usageUnits, 120_000 * CACHE_READ_METERING_WEIGHT);
  assert.equal(totalsOf(doc).usageUnits, 120_000 * CACHE_READ_METERING_WEIGHT);
  assert.equal(totalsOf(doc).pingsSent, 1);
});

test('the metering weight is pinned to core, which this package may not import', () => {
  // `stacks/claude/core` is not a dependency of this package and must not become one —
  // the proxy ships zero runtime dependencies — so the mirrored constant is held to its
  // source by reading that file rather than importing it. An import would also drag a
  // file outside this package's `rootDir` into its typecheck.
  const source = fs.readFileSync(path.join(HERE, '..', 'core', 'src', 'usage-limits.ts'), 'utf8');
  const declared = /export const CACHE_READ_METERING_WEIGHT = ([0-9.]+);/.exec(source);

  assert.ok(declared, 'core still declares CACHE_READ_METERING_WEIGHT');
  assert.equal(Number(declared[1]), CACHE_READ_METERING_WEIGHT, 'the mirror has drifted from usage-limits.ts');
});

test('a request arriving after a ping is recorded as a resume', async () => {
  reset();
  const now = Date.now();
  register({ sessionKey: 'sess-back', hours: 4, now });
  noteWarmRequest({ sessionKey: 'sess-back', account: 'acc-1', reqJson: plainBody(), headers: {}, startedAt: now });

  setBearerSource(() => 'Bearer live');
  setPingTransport(async () => ({ statusCode: 200, cacheReadTokens: 1_000 }));
  await sweepOnce(now + DEFAULT_CACHE_TTL_MS);
  assert.equal(rowsOf(warmStatusDocument())[0]?.outcome, null, 'still running, so no outcome yet');

  // The user comes back. This — not any stop reason — is what ADR 0078 measures the
  // feature's premise against, so it is observed here rather than inside the module.
  noteWarmRequest({
    sessionKey: 'sess-back',
    account: 'acc-1',
    reqJson: plainBody(),
    headers: {},
    startedAt: now + DEFAULT_CACHE_TTL_MS + 1_000,
  });

  const doc = warmStatusDocument();
  assert.equal(rowsOf(doc)[0]?.outcome, 'resumed');
  assert.equal(rowsOf(doc)[0]?.resumedAfterPings, 1);
  assert.equal(totalsOf(doc).resumed, 1);
});

// ------------------------------------------------------- the account-keyed bearer

test('a ping borrows only within its own account, never across', () => {
  resetAuth();
  noteAuth({ authorization: 'Bearer token-for-a' }, 'acc-a');
  noteAuth({ authorization: 'Bearer token-for-b' }, 'acc-b');

  assert.equal(bearerForAccount('acc-a'), 'Bearer token-for-a');
  assert.equal(bearerForAccount('acc-b'), 'Bearer token-for-b');
  // No cross-account fallback, and an entry with no account of its own gets nothing: it
  // stops as `no-credential` rather than reaching for the newest token seen anywhere.
  // Borrowing another account's token is what ADR 0076 scopes against.
  assert.equal(bearerForAccount('acc-unknown'), null);
  assert.equal(bearerForAccount(null), null);
});

test('the account-keyed store keeps the newest bearer for that account', () => {
  resetAuth();
  noteAuth({ authorization: 'Bearer stale' }, 'acc-a');
  noteAuth({ authorization: 'Bearer fresh' }, 'acc-a');

  // A warm entry's own captured credential ages with nothing to refresh it; another
  // live session on the same account is what keeps this one current.
  assert.equal(bearerForAccount('acc-a'), 'Bearer fresh');
});

test('the usage poll still sees one global bearer, exactly as before', () => {
  resetAuth();
  assert.equal(hasAuth(), false);

  noteAuth({ authorization: 'Bearer global-only' });
  assert.equal(hasAuth(), true, 'a caller that passes no account behaves as it always did');
  assert.equal(bearerForAccount(null), null, 'and the global one is not reachable by account');
});

test('an api key is still ignored, by account as well as globally', () => {
  resetAuth();
  noteAuth({ 'x-api-key': 'sk-ant-secret' }, 'acc-a');

  assert.equal(hasAuth(), false);
  assert.equal(bearerForAccount('acc-a'), null);
});

// --------------------------------------------------------------- the CI enumeration

test("every test file beside this one is named in the package's test script", () => {
  // `keepalive.test.ts` passed on its own for a whole ticket while running in no CI at
  // all, because this script enumerates its files by hand. This is the guard that makes
  // the next omission fail loudly instead of going unnoticed for another ticket.
  const manifest: { scripts?: { test?: string } } = JSON.parse(
    fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'),
  );
  const named = String(manifest.scripts?.test ?? '').split(/\s+/);
  const missing = fs
    .readdirSync(HERE)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => !named.includes(name));

  assert.deepEqual(missing, [], `add these to the proxy package's test script: ${missing.join(', ')}`);
});
