import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProxyPort } from './config.ts';

// ADR 0050: one root `.env` would bind a bare `PORT` to this stack's server too. The legacy
// name keeps working for this package alone.
test('CLAUDE_PROXY_PORT wins over the bare PORT', () => {
  assert.equal(resolveProxyPort({ CLAUDE_PROXY_PORT: '9301', PORT: '9302' }), 9301);
});

test('the bare PORT still resolves on its own', () => {
  assert.equal(resolveProxyPort({ PORT: '9303' }), 9303);
});

test('the default port is unchanged when neither name is set', () => {
  assert.equal(resolveProxyPort({}), 8787);
});
