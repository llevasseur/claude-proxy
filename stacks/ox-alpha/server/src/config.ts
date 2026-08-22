import { resolve } from "node:path";
import { DEFAULT_REPORT_TIMEZONE } from "@ox-alpha-proxy/core";

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

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function timezone(value: string | undefined): string {
  const candidate = value ?? DEFAULT_REPORT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
  } catch {
    throw new Error("REPORT_TZ must be a valid IANA timezone");
  }
  return candidate;
}

export function readConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): ServerConfig {
  const host = environment.SERVER_HOST?.trim() || "127.0.0.1";
  const port = integer(environment.SERVER_PORT, 8788, "SERVER_PORT", 0);
  if (port > 65535) throw new Error("SERVER_PORT must be <= 65535");
  const auditDirectory = resolve(cwd, environment.AUDIT_DIR ?? "logs/audit");
  return Object.freeze({
    host,
    port,
    auditDirectory,
    databasePath: resolve(cwd, environment.DATABASE_PATH ?? "logs/server.db"),
    proxyStatusPath: resolve(cwd, environment.PROXY_STATUS_PATH ?? "logs/audit/proxy-status.json"),
    reportTimezone: timezone(environment.REPORT_TZ),
    reconcileIntervalMs: integer(
      environment.RECONCILE_INTERVAL_MS,
      5000,
      "RECONCILE_INTERVAL_MS",
      100,
    ),
    keepaliveIntervalMs: integer(environment.SSE_KEEPALIVE_MS, 15000, "SSE_KEEPALIVE_MS", 100),
  });
}
