import { resolve } from 'node:path';

// Relative `AUDIT_DIR` and `PROXY_STATUS_FILE` resolve from the stack root — this package's
// parent, `stacks/codex/` — not from `process.cwd()`; absolute values still win. See ADR 0054.
const STACK_ROOT = resolve(import.meta.dirname, '..', '..');

export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly upstream: URL;
  readonly auditDirectory: string;
  readonly statusFile: string;
}

// The listener port comes from `CODEX_PROXY_PORT`; the bare `PROXY_PORT` this package has
// always read stays a fallback scoped to this package alone. See ADR 0050.
// 8026 is the port the `chadex` shell function pins; every sibling proxy on this
// machine claims 8787.
const DEFAULT_PORT = '8026';

// The ChatGPT OAuth flow `chadex` authenticates with serves only
// `/backend-api/codex/responses`; api.openai.com answers that path with a 404.
const DEFAULT_UPSTREAM = 'https://chatgpt.com';

function port(value: string | undefined, name: string): number {
  const parsed = Number(value ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 0 through 65535`);
  }
  return parsed;
}

function upstream(value: string | undefined): URL {
  const parsed = new URL(value ?? DEFAULT_UPSTREAM);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OPENAI_UPSTREAM must use http or https');
  }
  return parsed;
}

export function loadProxyConfig(environment: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const auditDirectory = resolve(STACK_ROOT, environment.AUDIT_DIR ?? 'logs/audit');
  return Object.freeze({
    host: environment.PROXY_HOST ?? '127.0.0.1',
    port: port(
      environment.CODEX_PROXY_PORT ?? environment.PROXY_PORT,
      // Name whichever variable was actually supplied, so a bad value reports the
      // operator's own name for it.
      environment.CODEX_PROXY_PORT === undefined ? 'PROXY_PORT' : 'CODEX_PROXY_PORT',
    ),
    upstream: upstream(environment.OPENAI_UPSTREAM),
    auditDirectory,
    statusFile: resolve(STACK_ROOT, environment.PROXY_STATUS_FILE ?? 'logs/proxy-status.json'),
  });
}
