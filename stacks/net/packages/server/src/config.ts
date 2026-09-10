// net-server configuration. Port resolution follows the ADR 0050 order: the
// scoped name wins, the bare name stays a fallback scoped to this package, and
// the default collides with nothing.

const DEFAULT_PORT = 8531;

export interface NetServerConfig {
  readonly host: string;
  readonly port: number;
  /** Origins allowed to PUT /api/config; GETs answer open CORS regardless. */
  readonly allowedOrigins: readonly string[];
}

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function readConfig(environment: NodeJS.ProcessEnv = process.env): NetServerConfig {
  const host = environment.HOST?.trim() || '127.0.0.1';
  // Name whichever variable was actually supplied, so a bad value reports the operator's name.
  const portName = environment.NET_SERVER_PORT === undefined ? 'PORT' : 'NET_SERVER_PORT';
  const rawPort = environment.NET_SERVER_PORT ?? environment.PORT ?? DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0) throw new Error(`${portName} must be an integer >= 0`);
  if (port > 65_535) throw new Error(`${portName} must be <= 65535`);
  const allowedOrigins = (environment.NET_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return Object.freeze({ host, port, allowedOrigins });
}
