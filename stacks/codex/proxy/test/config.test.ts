import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProxyConfig } from '../src/config.ts';

test('an unconfigured proxy listens where the chadex shell function calls', () => {
  // A start that reaches no `.env` — a zellij pane, a bare `node
  // proxy/src/proxy.ts` — still lands on 8026 rather than the sibling proxies' 8787.
  const config = loadProxyConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8026);
});

test('an unconfigured proxy forwards to the upstream that serves the chadex path', () => {
  // The ChatGPT OAuth flow serves only /backend-api/codex/responses; api.openai.com
  // answers that path with a 404.
  assert.equal(loadProxyConfig({}).upstream.origin, 'https://chatgpt.com');
});

test('OPENAI_UPSTREAM overrides the default', () => {
  assert.equal(
    loadProxyConfig({ OPENAI_UPSTREAM: 'https://api.openai.com' }).upstream.origin,
    'https://api.openai.com',
  );
});

test('OPENAI_UPSTREAM rejects a non-HTTP protocol', () => {
  assert.throws(() => loadProxyConfig({ OPENAI_UPSTREAM: 'ftp://example.com' }), /http or https/);
});

test('PROXY_PORT overrides the default', () => {
  assert.equal(loadProxyConfig({ PROXY_PORT: '0' }).port, 0);
});
