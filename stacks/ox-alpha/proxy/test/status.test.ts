import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProxyConfig } from '../src/config.ts';
import { ProxyStatusWriter } from '../src/proxy-status.ts';
import { startFixtureUpstream, startProxyOnEphemeralPort } from './helpers.ts';

test('status writer publishes a body-free JSON signal through a file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ox-alpha-status-test-'));
  const statusFile = join(base, 'status.json');
  const writer = new ProxyStatusWriter(statusFile, '127.0.0.1', 8787, 4242);

  await writer.write('startup');
  let value = JSON.parse(await readFile(statusFile, 'utf8')) as Record<string, unknown>;
  assert.equal(value.state, 'startup');
  assert.equal(value.pid, 4242);
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.listen, { host: '127.0.0.1', port: 8787 });
  assert.equal(value.rollingUsage, null);

  writer.setPort(9999);
  await writer.write('upstream-error');
  await writer.write('upstream-error');
  await writer.write('ready');
  value = JSON.parse(await readFile(statusFile, 'utf8'));
  assert.equal(value.state, 'ready');
  assert.deepEqual(value.listen, { host: '127.0.0.1', port: 9999 });
  assert.equal(value.upstreamErrorCount, 2);

  // Rolling usage accumulates sanitized counters only; no request data.
  await writer.noteUsage({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 50,
    reasoningOutputTokens: 10,
    totalTokens: 150,
  });
  await writer.noteUsage({
    inputTokens: 30,
    cachedInputTokens: 0,
    outputTokens: 12,
    reasoningOutputTokens: 0,
    totalTokens: 42,
  });
  value = JSON.parse(await readFile(statusFile, 'utf8'));
  const rolling = value.rollingUsage as Record<string, unknown>;
  assert.equal(rolling.requests, 2);
  assert.equal(rolling.inputTokens, 130);
  assert.equal(rolling.cachedInputTokens, 20);
  assert.equal(rolling.outputTokens, 62);
  assert.equal(rolling.reasoningOutputTokens, 10);
  assert.equal(rolling.totalTokens, 192);
  assert.ok(!JSON.stringify(value).includes('body'), 'status carries no body field');
});

test('config defaults and validation come only from process env', async () => {
  const config = loadProxyConfig({
    OPENAI_UPSTREAM: 'http://127.0.0.1:9',
    AUDIT_DIR: '/tmp/audit',
    PROXY_PORT: '9000',
  });
  assert.equal(config.port, 9000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.upstream.href, 'http://127.0.0.1:9/');
  assert.equal(config.auditDirectory, '/tmp/audit');
  assert.equal(config.statusFile, '/tmp/audit/proxy-status.json');

  assert.throws(() => loadProxyConfig({ OPENAI_UPSTREAM: 'ftp://x', PROXY_PORT: '1' }), /OPENAI_UPSTREAM/);
  assert.throws(() => loadProxyConfig({ PROXY_PORT: '70000' }), /PROXY_PORT/);
});

test('proxy lifecycle writes ready status through a live exchange', async () => {
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(200).end('{}');
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    await fetch(new URL('/anything', proxy.url));
    let status: Record<string, unknown> = {};
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        status = JSON.parse(await readFile(proxy.statusFile, 'utf8')) as Record<string, unknown>;
        if (status.state === 'ready') break;
      } catch {
        // Status file may not exist yet.
      }
      assert.ok(Date.now() < deadline, 'status file never reached ready');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(!JSON.stringify(status).includes('anything'), 'no request data in status file');
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test('a live Responses exchange publishes rolling usage beside the lifecycle state', async () => {
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'response',
        model: 'gpt-5',
        usage: {
          input_tokens: 30,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 12,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 42,
        },
      }),
    );
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    const response = await fetch(new URL('/v1/responses', proxy.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', input: 'hi' }),
    });
    assert.equal(response.status, 200);
    const deadline = Date.now() + 2000;
    for (;;) {
      let status: Record<string, unknown> = {};
      try {
        status = JSON.parse(await readFile(proxy.statusFile, 'utf8')) as Record<string, unknown>;
      } catch {
        // Status file may not exist yet.
      }
      const rolling = status.rollingUsage as Record<string, unknown> | null | undefined;
      if (rolling && rolling.requests === 1) {
        assert.equal(rolling.inputTokens, 30);
        assert.equal(rolling.outputTokens, 12);
        assert.equal(rolling.totalTokens, 42);
        break;
      }
      assert.ok(Date.now() < deadline, 'status file never carried rolling usage');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});
