import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readConfig } from '../src/config.ts';

// `stacks/codex/`, reached the way `src/config.ts` reaches it.
const STACK_ROOT = resolve(import.meta.dirname, '..', '..');

describe('the listener port', () => {
  // ADR 0050: fusion puts every stack under one root and one `.env`, so a bare `PORT`
  // would bind this server and claude's proxy together. The scoped name is the fix; the
  // legacy name keeps working for this package alone so nothing launched today breaks.
  test('the scoped name wins over the legacy bare name', () => {
    expect(readConfig({ CODEX_SERVER_PORT: '5001', PORT: '5002' }).port).toBe(5001);
  });

  test('the legacy bare name still resolves when the scoped name is absent', () => {
    expect(readConfig({ PORT: '5002' }).port).toBe(5002);
  });

  test('the default is the unchanged 4319', () => {
    expect(readConfig({}).port).toBe(4319);
  });

  test('a bad value reports the variable the operator actually set', () => {
    expect(() => readConfig({ PORT: 'nonsense' })).toThrow(/^PORT must be/);
    expect(() => readConfig({ CODEX_SERVER_PORT: 'nonsense' })).toThrow(/^CODEX_SERVER_PORT must be/);
  });
});

describe('audit directory resolution', () => {
  // Blocker (d): this defaulted to `logs` while `proxy/src/config.ts` writes sanitized
  // sidecars to `logs/audit`, one level below — so a clone with no `.env` ingested
  // nothing at all. Keep this literal in step with the proxy's default.
  test('the default names the directory the proxy writes to', () => {
    expect(readConfig({}).auditDirectory).toBe(resolve(STACK_ROOT, 'logs/audit'));
  });

  test('a relative override resolves from the stack root, not the launching cwd', () => {
    expect(readConfig({ AUDIT_DIR: 'elsewhere' }).auditDirectory).toBe(resolve(STACK_ROOT, 'elsewhere'));
  });

  test('an absolute override still wins', () => {
    expect(readConfig({ AUDIT_DIR: '/tmp/codex-audit' }).auditDirectory).toBe('/tmp/codex-audit');
  });
});
