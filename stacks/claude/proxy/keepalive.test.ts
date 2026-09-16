/**
 * Unit tests for the keep-alive module. Zero-dependency — Node's built-in runner,
 * which strips the types itself.
 *
 * Run:  node --test stacks/claude/proxy/keepalive.test.ts
 *
 * The body strip is the tested core: a ping is the stored body re-sent with
 * `max_tokens: 0`, and every byte that is not one of the four fields the API rejects
 * alongside it has to survive, or the cached prefix stops matching and the ping has
 * bought a cold write instead of a read.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _resetKeepalive,
  buildPingBody,
  DEFAULT_CACHE_TTL_MS,
  deriveTtlMs,
  MAX_DEADLINE_HOURS,
  noteRequest,
  type PingResult,
  pingNow,
  register,
  release,
  setBearerSource,
  setPingTransport,
  setUtilizationSource,
  snapshot,
  storableHeaders,
  sweepOnce,
  validateDeadlineHours,
} from './keepalive.ts';
import type { RequestBody } from './wire.ts';

const HOUR = 3_600_000;

/** A body shaped like a real forwarded request, with nothing the strip should touch. */
const plainBody = (): RequestBody => ({
  model: 'claude-opus-5',
  max_tokens: 32_000,
  system: [{ type: 'text', text: 'you are', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  metadata: { user_id: '{"account_uuid":"acc-1","session_id":"sess-1"}' },
  temperature: 1,
});

/** The body minus `max_tokens`, which the ping always rewrites and never preserves. */
function withoutMaxTokens(body: RequestBody | null): RequestBody {
  assert.ok(body !== null, 'expected a ping body');
  const rest = { ...body };
  delete rest.max_tokens;
  return rest;
}

// ---------------------------------------------------------------- the four strips

test('strips stream: true and nothing else', () => {
  const source: RequestBody = { ...plainBody(), stream: true };
  const ping = buildPingBody(source);

  assert.equal(ping?.stream, undefined);
  assert.equal(ping?.max_tokens, 0);
  assert.deepEqual(withoutMaxTokens(ping), withoutMaxTokens({ ...plainBody(), max_tokens: 0 }));
});

test('leaves stream: false alone — only `true` is the invalid combination', () => {
  const ping = buildPingBody({ ...plainBody(), stream: false });
  assert.equal(ping?.stream, false);
});

test('strips thinking when it is enabled, and leaves a disabled one', () => {
  const enabled = buildPingBody({ ...plainBody(), thinking: { type: 'enabled', budget_tokens: 10_000 } });
  assert.equal(enabled?.thinking, undefined);

  const disabled = buildPingBody({ ...plainBody(), thinking: { type: 'disabled' } });
  assert.deepEqual(disabled?.thinking, { type: 'disabled' });
});

test('strips output_config.format and keeps the rest of output_config', () => {
  const ping = buildPingBody({ ...plainBody(), output_config: { format: { type: 'json' }, other: 1 } });
  assert.deepEqual(ping?.output_config, { other: 1 });
});

test('drops output_config entirely when format was all it carried', () => {
  const ping = buildPingBody({ ...plainBody(), output_config: { format: { type: 'json' } } });
  assert.equal(ping?.output_config, undefined);
});

test('strips a forced tool_choice, of either forced kind', () => {
  assert.equal(buildPingBody({ ...plainBody(), tool_choice: { type: 'any' } })?.tool_choice, undefined);
  assert.equal(buildPingBody({ ...plainBody(), tool_choice: { type: 'tool', name: 'Read' } })?.tool_choice, undefined);
});

test('leaves a non-forced tool_choice exactly where it is', () => {
  const ping = buildPingBody({ ...plainBody(), tool_choice: { type: 'auto' } });
  assert.deepEqual(ping?.tool_choice, { type: 'auto' });
});

test('an otherwise-untouched body survives byte-identical apart from max_tokens', () => {
  const source = plainBody();
  const before = JSON.stringify(source);
  const ping = buildPingBody(source);

  assert.equal(JSON.stringify(withoutMaxTokens(ping)), JSON.stringify(withoutMaxTokens(source)));
  assert.equal(ping?.max_tokens, 0);
  // The source object is not mutated — the proxy still forwards it untouched.
  assert.equal(JSON.stringify(source), before);
});

test('all four strips at once still leave everything else standing', () => {
  const ping = buildPingBody({
    ...plainBody(),
    stream: true,
    thinking: { type: 'enabled' },
    output_config: { format: { type: 'json' } },
    tool_choice: { type: 'any' },
  });

  assert.deepEqual(withoutMaxTokens(ping), withoutMaxTokens({ ...plainBody(), max_tokens: 0 }));
});

test('a body that is not an object has no ping', () => {
  assert.equal(buildPingBody(null), null);
});

// ------------------------------------------------------------------ TTL derivation

test('derives the TTL from the cache_control the client shipped', () => {
  assert.equal(deriveTtlMs(plainBody()), HOUR);
  assert.equal(
    deriveTtlMs({ system: [{ type: 'text', cache_control: { type: 'ephemeral', ttl: '5m' } }] }),
    5 * 60_000,
  );
  assert.equal(deriveTtlMs({ system: [{ cache_control: { ttl: '30s' } }] }), 30_000);
});

test('reads a TTL carried on a message rather than on system', () => {
  const body: RequestBody = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { ttl: '1h' } }] }],
  };
  assert.equal(deriveTtlMs(body), HOUR);
});

test('falls back to the documented default when no cache_control carries a TTL', () => {
  assert.equal(deriveTtlMs({ system: [{ type: 'text', text: 'no breakpoint' }] }), DEFAULT_CACHE_TTL_MS);
  assert.equal(deriveTtlMs({ system: [{ cache_control: { type: 'ephemeral' } }] }), DEFAULT_CACHE_TTL_MS);
  assert.equal(deriveTtlMs({ system: [{ cache_control: { ttl: 'forever' } }] }), DEFAULT_CACHE_TTL_MS);
  assert.equal(deriveTtlMs(null), DEFAULT_CACHE_TTL_MS);
});

// --------------------------------------------------------------- the hours validator

test('passes a value above the old eight-hour ceiling through unchanged', () => {
  assert.equal(validateDeadlineHours(24), 24);
  assert.equal(validateDeadlineHours(8.5), 8.5);
  assert.equal(validateDeadlineHours(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('passes a small value through untouched', () => {
  assert.equal(validateDeadlineHours(0.5), 0.5);
  assert.equal(validateDeadlineHours(MAX_DEADLINE_HOURS), MAX_DEADLINE_HOURS);
});

test('refuses a value below the floor', () => {
  assert.equal(validateDeadlineHours(0), null);
  assert.equal(validateDeadlineHours(-1), null);
});

test('refuses a non-finite value', () => {
  assert.equal(validateDeadlineHours(Number.NaN), null);
  assert.equal(validateDeadlineHours(Number.POSITIVE_INFINITY), null);
  assert.equal(validateDeadlineHours(Number.NEGATIVE_INFINITY), null);
  assert.equal(validateDeadlineHours(null), null);
  assert.equal(validateDeadlineHours(undefined), null);
});

// ------------------------------------------------------------------ the registry

/** Register, match a request against it, and arm it at t=0. */
function armed(): void {
  _resetKeepalive();
  setBearerSource(() => 'Bearer fresh');
  assert.equal(register({ sessionKey: 'sess-1', hours: 1, now: 0 }).ok, true);
  noteRequest({ sessionKey: 'sess-1', account: 'acc-1', body: plainBody(), headers: {}, startedAt: 0 });
}

const okPing = (cacheReadTokens = 1_000): PingResult => ({ statusCode: 200, cacheReadTokens });

test('a registration stays pending until a real request matches it', () => {
  _resetKeepalive();
  register({ sessionKey: 'sess-1', hours: 1, now: 0 });
  assert.equal(snapshot()[0]?.state, 'pending');

  noteRequest({ sessionKey: 'sess-1', account: 'acc-1', body: plainBody(), startedAt: 10 });
  assert.equal(snapshot()[0]?.state, 'armed');
  assert.equal(snapshot()[0]?.account, 'acc-1');
  assert.equal(snapshot()[0]?.ttlMs, HOUR);
});

test('a registration nothing ever matched stops as unmatched', async () => {
  _resetKeepalive();
  register({ sessionKey: 'sess-1', hours: 1, now: 0 });
  await sweepOnce(3 * 60_000);
  assert.deepEqual(snapshot()[0]?.outcome?.reason, 'unmatched');
});

test('a bad hours value is refused rather than defaulted', () => {
  _resetKeepalive();
  assert.equal(register({ sessionKey: 'sess-1', hours: Number.NaN, now: 0 }).ok, false);
  assert.equal(snapshot().length, 0);
});

test('pings once the padded interval has passed, and counts what it read', async () => {
  armed();
  let sent = 0;
  setPingTransport(async () => {
    sent += 1;
    return okPing(2_500);
  });

  await sweepOnce(3_000_000); // past 83% of an hour
  assert.equal(sent, 1);
  assert.equal(snapshot()[0]?.pingsSent, 1);
  assert.equal(snapshot()[0]?.cacheReadTokens, 2_500);
});

test('does not ping before the padded interval', async () => {
  armed();
  let sent = 0;
  setPingTransport(async () => {
    sent += 1;
    return okPing();
  });

  await sweepOnce(60_000);
  assert.equal(sent, 0);
});

test('a real request arriving resets the clock and skips the ping', async () => {
  armed();
  let sent = 0;
  setPingTransport(async () => {
    sent += 1;
    return okPing();
  });

  noteRequest({ sessionKey: 'sess-1', startedAt: 2_900_000 });
  await sweepOnce(3_000_000);
  assert.equal(sent, 0, 'the entry is no longer due');
  assert.equal(snapshot()[0]?.state, 'armed');
});

test('the hard deadline retires the entry', async () => {
  armed();
  await sweepOnce(HOUR + 1);
  assert.equal(snapshot()[0]?.state, 'stopped');
  assert.equal(snapshot()[0]?.outcome?.reason, 'deadline');
});

test('401 and 403 are reported as a credential expiry, not as a ping failure', async () => {
  for (const status of [401, 403]) {
    armed();
    setPingTransport(async () => ({ statusCode: status, cacheReadTokens: 0 }));
    await sweepOnce(3_000_000);

    const outcome = snapshot()[0]?.outcome;
    assert.equal(outcome?.reason, 'credential-expired', `HTTP ${status} must name itself`);
    assert.equal(outcome?.detail, `HTTP ${status}`);
  }
});

test('429 and 529 retire the entry as rate-limited', async () => {
  for (const status of [429, 529]) {
    armed();
    setPingTransport(async () => ({ statusCode: status, cacheReadTokens: 0 }));
    await sweepOnce(3_000_000);
    assert.equal(snapshot()[0]?.outcome?.reason, 'rate-limited');
  }
});

test('one failure is a wobble; two in a row retire the entry', async () => {
  armed();
  setPingTransport(async () => ({ statusCode: 500, cacheReadTokens: 0 }));

  await sweepOnce(3_000_000);
  assert.equal(snapshot()[0]?.state, 'armed', 'a single 500 is not a stop');

  await sweepOnce(3_100_000);
  assert.equal(snapshot()[0]?.outcome?.reason, 'ping-failures');
});

test('a transport that throws counts as a failure rather than escaping', async () => {
  armed();
  setPingTransport(async () => {
    throw new Error('socket hang up');
  });

  await sweepOnce(3_000_000);
  await sweepOnce(3_100_000);
  assert.equal(snapshot()[0]?.outcome?.reason, 'ping-failures');
});

test('no bearer for the account means no ping and a recorded reason', async () => {
  armed();
  setBearerSource(() => null);
  let sent = 0;
  setPingTransport(async () => {
    sent += 1;
    return okPing();
  });

  await sweepOnce(3_000_000);
  assert.equal(sent, 0);
  assert.equal(snapshot()[0]?.outcome?.reason, 'no-credential');
});

test('the bearer is taken at send time, scoped to the entry account', async () => {
  armed();
  const asked: (string | null)[] = [];
  setBearerSource((account) => {
    asked.push(account);
    return 'Bearer newest';
  });
  let seen: string | undefined;
  setPingTransport(async ({ headers }) => {
    seen = headers.authorization;
    return okPing();
  });

  await sweepOnce(3_000_000);
  assert.deepEqual(asked, ['acc-1']);
  assert.equal(seen, 'Bearer newest');
});

test('utilization above the threshold stops the entry before it spends more', async () => {
  armed();
  setUtilizationSource(() => 0.95, 0.9);
  let sent = 0;
  setPingTransport(async () => {
    sent += 1;
    return okPing();
  });

  await sweepOnce(3_000_000);
  assert.equal(sent, 0);
  assert.equal(snapshot()[0]?.outcome?.reason, 'usage-limit');
});

test('an unknown utilization never stops an entry', async () => {
  armed();
  setUtilizationSource(() => null);
  setPingTransport(async () => okPing());

  await sweepOnce(3_000_000);
  assert.equal(snapshot()[0]?.state, 'armed');
});

test('release retires an entry deliberately', () => {
  armed();
  assert.equal(release('sess-1', 500), true);
  assert.equal(snapshot()[0]?.outcome?.reason, 'released');
  assert.equal(release('sess-1', 600), false, 'a stopped entry is not stopped twice');
});

test('a ping replays the stored headers and never the stored credential', async () => {
  _resetKeepalive();
  setBearerSource(() => 'Bearer fresh');
  register({ sessionKey: 'sess-1', hours: 1, now: 0 });
  noteRequest({
    sessionKey: 'sess-1',
    account: 'acc-1',
    body: plainBody(),
    headers: { 'anthropic-version': '2023-06-01', authorization: 'Bearer stale', 'x-api-key': 'sk-secret' },
    startedAt: 0,
  });

  let headers: Record<string, string> = {};
  setPingTransport(async (request) => {
    headers = request.headers;
    return okPing();
  });
  await sweepOnce(3_000_000);

  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.authorization, 'Bearer fresh');
  assert.equal(headers['x-api-key'], undefined);
});

test('storableHeaders drops the credential and the hop-by-hop names', () => {
  const kept = storableHeaders({
    authorization: 'Bearer secret',
    'x-api-key': 'sk-secret',
    cookie: 'a=b',
    host: 'localhost',
    'content-length': '12',
    'anthropic-beta': ['oauth-2025-04-20', 'other'],
    'user-agent': 'claude-cli',
  });

  assert.deepEqual(kept, { 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-cli' });
});

test('the snapshot carries counts and reasons, never a body or a credential', async () => {
  armed();
  setPingTransport(async () => okPing());
  await sweepOnce(3_000_000);

  const serialized = JSON.stringify(snapshot());
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(serialized.includes('you are'), false);
  assert.equal(serialized.includes('user_id'), false);
  assert.deepEqual(Object.keys(snapshot()[0] ?? {}).includes('body'), false);
});

test('the reset seam empties the registry and the wired seams', () => {
  armed();
  _resetKeepalive();
  assert.deepEqual(snapshot(), []);
});

// ------------------------------------------------- what the last ping actually read

test('a successful ping records all four token counts, not the cache read alone', async () => {
  armed();
  setPingTransport(async () => ({
    statusCode: 200,
    inputTokens: 240,
    cacheCreationTokens: 0,
    cacheReadTokens: 31_402,
    outputTokens: 1,
  }));
  await sweepOnce(3_000_000);

  const last = snapshot()[0]?.lastPing;
  assert.ok(last, 'expected the ping to be recorded');
  assert.equal(last.statusCode, 200);
  assert.equal(last.inputTokens, 240);
  assert.equal(last.cacheCreationTokens, 0);
  assert.equal(last.cacheReadTokens, 31_402);
  assert.equal(last.outputTokens, 1);
  assert.equal(last.at, 3_000_000, 'measured from the instant the ping began');
});

test('a refused ping is recorded too, which is the case the cumulative count hid', async () => {
  // A 400 never increments `pingsSent`, so before `lastPing` it left no trace at all —
  // indistinguishable from a ping that was never due.
  armed();
  setPingTransport(async () => ({ statusCode: 400, cacheReadTokens: 0 }));
  await sweepOnce(3_000_000);

  const entry = snapshot()[0];
  assert.equal(entry?.pingsSent, 0, 'a refusal is still not a ping sent');
  assert.equal(entry?.lastPing?.statusCode, 400, 'but it is visible');
});

test('a ping that reads no cache is distinguishable from one that reported no usage', async () => {
  armed();
  setPingTransport(async () => ({ statusCode: 200, inputTokens: 31_000, cacheReadTokens: 0 }));
  await sweepOnce(3_000_000);
  assert.equal(snapshot()[0]?.lastPing?.inputTokens, 31_000, 'paid for the prefix, read none of it');

  armed();
  setPingTransport(async () => ({ statusCode: 200, cacheReadTokens: 0 }));
  await sweepOnce(3_000_000);
  assert.equal(snapshot()[0]?.lastPing?.inputTokens, 0, 'reported nothing either way');
});

// --------------------------------------------------------- the forced ping (pingNow)

test('pingNow sends outside the padded schedule and answers what came back', async () => {
  armed();
  setPingTransport(async () => okPing(12_345));

  // Far short of 83% of the hour this body asks for: the sweep would send nothing here.
  const result = await pingNow('sess-1', 60_000);

  assert.equal(result.ok, true);
  assert.equal(result.state, 'armed');
  assert.equal(result.lastPing?.cacheReadTokens, 12_345);
  assert.equal(snapshot()[0]?.pingsSent, 1);
});

test('a forced ping moves lastActivity, so the next scheduled one is measured from it', async () => {
  armed();
  setPingTransport(async () => okPing());
  await pingNow('sess-1', 60_000);

  // 83% of an hour after the forced ping, not after the registration.
  await sweepOnce(60_000 + 2_000_000);
  assert.equal(snapshot()[0]?.pingsSent, 1, 'not yet due');
  await sweepOnce(60_000 + 3_000_000);
  assert.equal(snapshot()[0]?.pingsSent, 2, 'due, measured from the forced ping');
});

test('pingNow refuses rather than pinging what the sweep would not have pinged', async () => {
  _resetKeepalive();
  setBearerSource(() => 'Bearer fresh');
  setPingTransport(async () => okPing());

  const unknown = await pingNow('nobody');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.state, undefined, 'no state at all is how the endpoint tells a 404 from a 409');
  assert.match(String(unknown.reason), /no such registration/);

  register({ sessionKey: 'sess-1', hours: 1, now: 0 });
  const pending = await pingNow('sess-1', 1_000);
  assert.equal(pending.ok, false);
  assert.equal(pending.state, 'pending');
  assert.match(String(pending.reason), /pending/);

  release('sess-1');
  const stopped = await pingNow('sess-1', 2_000);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.state, 'stopped');
});

test('pingNow refuses past the deadline and with no credential for the account', async () => {
  armed();
  setPingTransport(async () => okPing());
  const late = await pingNow('sess-1', HOUR + 1);
  assert.equal(late.ok, false);
  assert.match(String(late.reason), /deadline/);

  armed();
  setBearerSource(() => null);
  const uncredentialed = await pingNow('sess-1', 60_000);
  assert.equal(uncredentialed.ok, false);
  assert.match(String(uncredentialed.reason), /credential/);
  assert.equal(snapshot()[0]?.pingsSent, 0, 'nothing was sent');
});
