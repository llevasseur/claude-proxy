import { dirname, join, resolve } from 'node:path';

// Config mechanics ported from codex-proxy `proxy/src/config.ts`: the process
// environment is the sole configuration surface. Boat body capture is OFF
// unless explicitly enabled with CAPTURE_BODIES (ADR 0002/0004).
export interface ProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly upstream: URL;
  readonly auditDirectory: string;
  readonly statusFile: string;
  readonly captureEnabled: boolean;
  readonly captureDirectory: string;
  readonly captureRedactionPatterns: readonly string[];
}

// Relative AUDIT_DIR, PROXY_STATUS_FILE and CAPTURE_DIR resolve from the stack root — this
// package's parent, `stacks/ox-alpha/` — not from process.cwd(); absolute values still win.
// See ADR 0054.
const STACK_ROOT = resolve(import.meta.dirname, '..', '..');

// The listener port comes from `OX_PROXY_PORT`; the bare `PROXY_PORT` this package has always
// read stays a fallback scoped to this package alone. See ADR 0050. 8787 is claimed by every
// sibling proxy on this machine, so this one owns 8807 and that number is unchanged.
const DEFAULT_PORT = '8807';

// api.openai.com 404s the paths this proxy forwards.
const DEFAULT_UPSTREAM = 'https://opencode.ai';

const TRUE_FLAG_VALUES = new Set(['1', 'true', 'on', 'yes']);
const FALSE_FLAG_VALUES = new Set(['0', 'false', 'off', 'no', '']);

function captureFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (TRUE_FLAG_VALUES.has(normalized)) return true;
  if (FALSE_FLAG_VALUES.has(normalized)) return false;
  throw new Error('CAPTURE_BODIES must be a boolean (true/false/1/0/on/off/yes/no)');
}

function redactionPatterns(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return [];
  const sources = value
    .split(',')
    .map((source) => source.trim())
    .filter((source) => source.length > 0);
  for (const source of sources) new RegExp(source); // Fail fast on invalid patterns.
  return Object.freeze(sources);
}

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
      environment.OX_PROXY_PORT ?? environment.PROXY_PORT,
      // Name whichever variable was actually supplied, so a bad value reports the
      // operator's own name for it.
      environment.OX_PROXY_PORT === undefined ? 'PROXY_PORT' : 'OX_PROXY_PORT',
    ),
    upstream: upstream(environment.OPENAI_UPSTREAM),
    auditDirectory,
    statusFile: resolve(STACK_ROOT, environment.PROXY_STATUS_FILE ?? `${auditDirectory}/proxy-status.json`),
    captureEnabled: captureFlag(environment.CAPTURE_BODIES),
    captureDirectory: resolve(STACK_ROOT, environment.CAPTURE_DIR ?? join(dirname(auditDirectory), 'captures')),
    captureRedactionPatterns: redactionPatterns(environment.CAPTURE_REDACT_PATTERNS),
  });
}
