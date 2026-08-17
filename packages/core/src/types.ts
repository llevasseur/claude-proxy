import { jsonArray, jsonNumber, jsonObject, jsonText, jsonValueOf } from './json.js';

/**
 * The audit sidecar written by the proxy next to each captured request
 * (`<ts>_anthropic.audit.json`). This type mirrors exactly what
 * `proxy/proxy.ts` emits — keep the two in sync.
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

/**
 * Identity of the request's system prompt. The outline itself lives once per
 * hash in `logs/system-prompts/<hash>.json`, so a repeated prompt costs one
 * short string per request instead of its whole table of contents. Absent on
 * sidecars written before the capture existed.
 */
export interface AuditSystemPrompt {
  /** Content hash of the serialized `system` field. */
  hash: string;
  /** Top-level blocks in the `system` array. */
  blocks: number;
  /** Heading spans across all blocks. */
  sections: number;
}

export interface AuditRequestMeta {
  toolCount: number;
  toolsBytes: number;
  systemBytes: number;
  totalBytes: number;
  system?: AuditSystemPrompt;
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
  /**
   * Which transcript this request is a turn of — the stem of
   * `logs/sessions/<threadId>.md`. A session id is shared by a run and every subagent
   * under it, so joining on `sessionId` alone attributes a subagent's request to its
   * parent's thread; this does not. Absent on legacy sidecars and on requests with no
   * user text to root on, so consumers must keep the session-wide fallback.
   */
  threadId?: string;
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
   * Whether the proxy put back a message-level `cache_control` breakpoint the CLI
   * dropped on this request. Absent on sidecars written before the injector
   * existed, which is why the substrate's column is nullable rather than
   * defaulting to false.
   *
   * The day's total is `UsageDigest.cacheBreakpointInjections`.
   */
  cacheBreakpointInjected?: boolean;
  /**
   * Whether the CLI dropped the breakpoint on this request at all, recorded whether
   * or not the proxy went on to inject one. Absent on sidecars written before the
   * injector reported it, so the column is nullable for the same reason
   * `cacheBreakpointInjected`'s is: a real "did not happen" must stay
   * distinguishable from no reading at all.
   *
   * The day's total is `UsageDigest.cacheBreakpointObservations`, and *this* is the
   * retirement trigger rather than the injection count — the later gates decline most
   * occurrences, so zero injections is also what a still-broken CLI looks like. Once
   * observations stay at zero after a CLI upgrade, `cache-breakpoint.ts` can go.
   */
  cacheBreakpointObserved?: boolean;
  /**
   * Which gate declined an observed occurrence (`depth`, `cold-prefix`,
   * `no-content-block`), so zero injections against non-zero observations says which
   * threshold is turning them away. Null when nothing declined — the injection
   * happened, or the defect was not observed. Absent on sidecars predating the field.
   */
  cacheBreakpointDeclinedBy?: string | null;
  /**
   * Upstream `anthropic-ratelimit-*` response headers, verbatim with lowercased
   * names — the authoritative remaining allowance behind the usage meters. Absent
   * on older sidecars and on responses that carried no such header.
   */
  rateLimit?: Record<string, string>;
}

/**
 * Structural guard for a parsed-but-untrusted sidecar. Malformed files are
 * skipped by the digest rather than aborting the whole run.
 *
 * Generic in its input, which is what lets the `readonly unknown[]` a log
 * directory reader holds filter down to `AuditSidecar[]` in `server/`.
 */
export function isAuditSidecar<Candidate>(value: Candidate): value is Candidate & AuditSidecar {
  const record = jsonObject(jsonValueOf(value));
  if (record === null) return false;
  if (jsonText(record.timestamp) === null) return false;
  if (jsonText(record.model) === null) return false;
  const tokens = jsonObject(record.tokens);
  if (tokens === null) return false;
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreation', 'realInput']) {
    if (jsonNumber(tokens[key]) === null) return false;
  }
  const request = jsonObject(record.request);
  if (request === null) return false;
  for (const key of ['toolCount', 'toolsBytes', 'systemBytes', 'totalBytes']) {
    if (jsonNumber(request[key]) === null) return false;
  }
  return jsonArray(record.tools) !== null;
}
