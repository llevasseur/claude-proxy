import { resolve } from 'node:path';

// Relative `AUDIT_DIR` and `PROXY_STATUS_FILE` resolve from the stack root — this
// package's parent, `stacks/codex/` — rather than from `process.cwd()` or from the
// repository root; absolute values still win. `import.meta.dirname/../..` has always
// meant "my stack's root"; before relocation that happened to coincide with the
// repository root, which is what the old name asserted. See ADR 0054.
const STACK_ROOT = resolve(import.meta.dirname, '..', '..');

export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly upstream: URL;
  readonly auditDirectory: string;
  readonly statusFile: string;
}

// 8026 is the port the `chadex` shell function pins; every sibling proxy on this
// machine claims 8787.
const DEFAULT_PORT = '8026';

// The ChatGPT OAuth flow `chadex` authenticates with serves only
// `/backend-api/codex/responses`; api.openai.com answers that path with a 404.
const DEFAULT_UPSTREAM = 'https://chatgpt.com';

function port(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error('PROXY_PORT must be an integer from 0 through 65535');
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
    port: port(environment.PROXY_PORT),
    upstream: upstream(environment.OPENAI_UPSTREAM),
    auditDirectory,
    statusFile: resolve(STACK_ROOT, environment.PROXY_STATUS_FILE ?? 'logs/proxy-status.json'),
  });
}
