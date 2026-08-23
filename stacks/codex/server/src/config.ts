import { resolve } from 'node:path';
import { DEFAULT_REPORT_TIMEZONE } from '@agent-proxy/codex-core';

// Relative `AUDIT_DIR`, `DATABASE_PATH` and `PROXY_STATUS_PATH` resolve from the stack
// root — this package's parent, `stacks/codex/` — rather than from `process.cwd()` or
// from the repository root; absolute values still win. `import.meta.dirname/../..` has
// always meant "my stack's root"; before relocation that happened to coincide with the
// repository root, which is what the old name asserted. See ADR 0054.
const STACK_ROOT = resolve(import.meta.dirname, '..', '..');

// The listener port is read from `CODEX_SERVER_PORT`, with the bare `PORT` this package
// has always read kept as a fallback scoped to this package alone — so a stack launched
// the way it is launched today resolves the way it does today. The scoped name exists
// because one root `.env` would otherwise bind a single exported `PORT` to both this
// server and claude's proxy. See ADR 0050.
const DEFAULT_PORT = 4319;

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly auditDirectory: string;
  readonly databasePath: string;
  readonly proxyStatusPath: string;
  readonly reportTimezone: string;
  readonly reconcileIntervalMs: number;
  readonly keepaliveIntervalMs: number;
}

function integer(value: string | undefined, fallback: number, name: string, minimum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function timezone(value: string | undefined): string {
  const candidate = value ?? DEFAULT_REPORT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format();
  } catch {
    throw new Error('REPORT_TZ must be a valid IANA timezone');
  }
  return candidate;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env, stackRoot = STACK_ROOT): ServerConfig {
  const host = environment.HOST?.trim() || '127.0.0.1';
  // Name whichever variable was actually supplied, so a bad value reports the name the
  // operator wrote rather than the one this package prefers.
  const portName = environment.CODEX_SERVER_PORT === undefined ? 'PORT' : 'CODEX_SERVER_PORT';
  const port = integer(environment.CODEX_SERVER_PORT ?? environment.PORT, DEFAULT_PORT, portName, 0);
  if (port > 65_535) throw new Error(`${portName} must be <= 65535`);
  // The proxy writes sanitized sidecars to `logs/audit` (proxy/src/config.ts). This
  // default read `logs`, one level above them, so a clone with no `.env` ingested
  // nothing at all — the two defaults now name the same directory.
  const auditDirectory = resolve(stackRoot, environment.AUDIT_DIR ?? 'logs/audit');
  return Object.freeze({
    host,
    port,
    auditDirectory,
    databasePath: resolve(stackRoot, environment.DATABASE_PATH ?? 'logs/codex-proxy.db'),
    proxyStatusPath: resolve(stackRoot, environment.PROXY_STATUS_PATH ?? 'logs/proxy-status.json'),
    reportTimezone: timezone(environment.REPORT_TZ),
    reconcileIntervalMs: integer(environment.RECONCILE_INTERVAL_MS, 5_000, 'RECONCILE_INTERVAL_MS', 100),
    keepaliveIntervalMs: integer(environment.SSE_KEEPALIVE_MS, 15_000, 'SSE_KEEPALIVE_MS', 100),
  });
}
