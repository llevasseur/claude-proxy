import { dirname, join, resolve } from "node:path";
import { DEFAULT_REPORT_TIMEZONE, USAGE_WINDOWS, type UsageWindowKind } from "@agent-proxy/ox-core";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly auditDirectory: string;
  readonly databasePath: string;
  readonly proxyStatusPath: string;
  readonly reportTimezone: string;
  readonly reconcileIntervalMs: number;
  readonly keepaliveIntervalMs: number;
  readonly captureEnabled: boolean;
  readonly captureDirectory: string;
  readonly captureRetentionMs: number;
  readonly captureMaxBytes: number;
  // Operator-supplied metering ceilings per usage window; a missing value
  // omits that window from /api/limits rather than inventing a denominator.
  readonly usageLimitCeilings: Readonly<Partial<Record<UsageWindowKind, number>>>;
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

const USAGE_LIMIT_ENV_SUFFIX: Readonly<Record<UsageWindowKind, string>> = Object.freeze({
  "5h": "5H",
  week: "WEEK",
});

function usageLimitCeilings(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Partial<Record<UsageWindowKind, number>>> {
  const ceilings: Partial<Record<UsageWindowKind, number>> = {};
  for (const kind of USAGE_WINDOWS) {
    const raw = environment[`USAGE_LIMIT_${USAGE_LIMIT_ENV_SUFFIX[kind]}`];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`USAGE_LIMIT_${USAGE_LIMIT_ENV_SUFFIX[kind]} must be a number >= 0`);
    }
    ceilings[kind] = parsed;
  }
  return Object.freeze(ceilings);
}

// Boat capture is OFF unless explicitly enabled. Proxy and server share the
// CAPTURE_BODIES flag so a proxy capturing while the server is disabled is a
// visible, deliberate mismatch rather than an accident.
const TRUE_FLAG_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_FLAG_VALUES = new Set(["0", "false", "off", "no", ""]);

function captureFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (TRUE_FLAG_VALUES.has(normalized)) return true;
  if (FALSE_FLAG_VALUES.has(normalized)) return false;
  throw new Error("CAPTURE_BODIES must be a boolean (true/false/1/0/on/off/yes/no)");
}

export function readConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): ServerConfig {
  const host = environment.SERVER_HOST?.trim() || "127.0.0.1";
  // The listener port comes from `OX_SERVER_PORT`; the bare `SERVER_PORT` this package has
  // always read stays a fallback scoped to this package alone. See ADR 0050. The 8788 default
  // is unchanged and still collides with claude's server — pre-existing rather than
  // fusion-caused, and the scoped name is what makes it overridable.
  const portName = environment.OX_SERVER_PORT === undefined ? "SERVER_PORT" : "OX_SERVER_PORT";
  const port = integer(environment.OX_SERVER_PORT ?? environment.SERVER_PORT, 8788, portName, 0);
  if (port > 65535) throw new Error(`${portName} must be <= 65535`);
  const auditDirectory = resolve(cwd, environment.AUDIT_DIR ?? "logs/audit");
  const base = Object.freeze({
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
  const captureDirectory = resolve(
    cwd,
    environment.CAPTURE_DIR ?? join(dirname(auditDirectory), "captures"),
  );
  return Object.freeze({
    ...base,
    captureEnabled: captureFlag(environment.CAPTURE_BODIES),
    captureDirectory,
    // Default retention: 7 days; default cap: 256 MiB of redacted capture text.
    captureRetentionMs: integer(
      environment.CAPTURE_RETENTION_MS,
      604_800_000,
      "CAPTURE_RETENTION_MS",
      1,
    ),
    captureMaxBytes: integer(environment.CAPTURE_MAX_BYTES, 268_435_456, "CAPTURE_MAX_BYTES", 1),
    usageLimitCeilings: usageLimitCeilings(environment),
  });
}
