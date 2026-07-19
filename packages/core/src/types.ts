/**
 * The audit sidecar written by the proxy next to each captured request
 * (`<ts>_anthropic.audit.json`). This type mirrors exactly what
 * `proxy/proxy.mjs` emits — keep the two in sync.
 */
export interface AuditTokens {
  /** Non-cached input tokens billed at the input rate. */
  input: number;
  output: number;
  /** Tokens read from the prompt cache (cheap). */
  cacheRead: number;
  /** Tokens written to the prompt cache (cache-creation, priced above input). */
  cacheCreation: number;
  /** input + cacheRead + cacheCreation — the true prompt size sent to the model. */
  realInput: number;
}

export interface AuditRequestMeta {
  toolCount: number;
  toolsBytes: number;
  systemBytes: number;
  totalBytes: number;
}

export interface AuditTool {
  name: string;
  bytes: number;
  estTokens: number;
}

/**
 * Opt-in app-layer response-cache record, distinct from Anthropic's prefix
 * cache. Legacy sidecars may omit it.
 */
export interface AuditSkim {
  /** Whether `SKIM_CACHE` was enabled at capture time. */
  enabled: boolean;
  /** True when the reply was replayed from cache with zero upstream call. */
  servedFromCache: boolean;
  /** Input tokens avoided upstream; 0 on a miss. */
  savedInputTokens: number;
  /** Byte-exact request hash; null when not cacheable. */
  cacheKey: string | null;
}

export interface AuditSidecar {
  /** ISO 8601 timestamp of the request. */
  timestamp: string;
  model: string;
  endpoint: string;
  statusCode: number;
  tokens: AuditTokens;
  request: AuditRequestMeta;
  tools: AuditTool[];
  /** Present on sidecars written since ticket 001. */
  skim?: AuditSkim;
}

/**
 * Structural guard for a parsed-but-untrusted sidecar. Malformed files are
 * skipped by the digest rather than aborting the whole run.
 */
export function isAuditSidecar(value: unknown): value is AuditSidecar {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.timestamp !== "string") return false;
  if (typeof v.model !== "string") return false;
  const t = v.tokens as Record<string, unknown> | undefined;
  if (typeof t !== "object" || t === null) return false;
  for (const key of ["input", "output", "cacheRead", "cacheCreation", "realInput"]) {
    if (typeof t[key] !== "number") return false;
  }
  const r = v.request as Record<string, unknown> | undefined;
  if (typeof r !== "object" || r === null) return false;
  for (const key of ["toolCount", "toolsBytes", "systemBytes", "totalBytes"]) {
    if (typeof r[key] !== "number") return false;
  }
  if (!Array.isArray(v.tools)) return false;
  return true;
}
