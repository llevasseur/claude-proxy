import { resolve } from 'node:path';
import { DEFAULT_REPORT_TIMEZONE } from '@codex-proxy/core';

// Relative `AUDIT_DIR`, `DATABASE_PATH` and `PROXY_STATUS_PATH` values resolve from here
// rather than `process.cwd()`, so `pnpm --filter server start` (cwd `server/`) and a
// root-level run open the same database. Absolute values still win.
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');

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

export function readConfig(environment: NodeJS.ProcessEnv = process.env, cwd = REPOSITORY_ROOT): ServerConfig {
  const host = environment.HOST?.trim() || '127.0.0.1';
  const port = integer(environment.PORT, 4319, 'PORT', 0);
  if (port > 65_535) throw new Error('PORT must be <= 65535');
  const auditDirectory = resolve(cwd, environment.AUDIT_DIR ?? 'logs');
  return Object.freeze({
    host,
    port,
    auditDirectory,
    databasePath: resolve(cwd, environment.DATABASE_PATH ?? 'logs/codex-proxy.db'),
    proxyStatusPath: resolve(cwd, environment.PROXY_STATUS_PATH ?? 'logs/proxy-status.json'),
    reportTimezone: timezone(environment.REPORT_TZ),
    reconcileIntervalMs: integer(environment.RECONCILE_INTERVAL_MS, 5_000, 'RECONCILE_INTERVAL_MS', 100),
    keepaliveIntervalMs: integer(environment.SSE_KEEPALIVE_MS, 15_000, 'SSE_KEEPALIVE_MS', 100),
  });
}
