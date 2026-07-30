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

/**
 * Who sent the request, read off Claude Code's headers and `metadata.user_id`.
 * Never carries auth. Legacy sidecars may omit it.
 */
export interface AuditSession {
  /** Claude Code's session id — the handle that ties a request to a transcript. */
  sessionId: string | null;
  /** `"-bg"` suffix marks a background agent. */
  app: string | null;
  userAgent: string | null;
  account: string | null;
  metadataSessionId: string | null;
  deviceId: string | null;
}

export interface AuditSidecar {
  /** ISO 8601 timestamp of the request. */
  timestamp: string;
  model: string;
  endpoint: string;
  statusCode: number;
  session?: AuditSession;
  tokens: AuditTokens;
  request: AuditRequestMeta;
  tools: AuditTool[];
  /** Present on sidecars written since ticket 001. */
  skim?: AuditSkim;
  /**
   * Upstream `anthropic-ratelimit-*` response headers, names lowercased and kept
   * verbatim. This is Anthropic's own account of the subscription's remaining
   * allowance, so it drives the usage meters when present. Absent on sidecars
   * written before capture existed, and on responses that carried no such header.
   */
  rateLimit?: Record<string, string>;
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
