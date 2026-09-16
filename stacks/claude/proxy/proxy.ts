#!/usr/bin/env node
/**
 * agent-proxy — see what Claude Code actually sends the model.
 *
 * A zero-dependency logging proxy for Claude Code. It sits between the CLI and
 * the Anthropic API, forwards each request essentially untouched (auth header
 * and all), streams the response straight back so the CLI is unaffected, and
 * for each request writes a readable Markdown document — led by a ranked table
 * of what is eating your context.
 *
 * Its deliberate edits: it strips `WITHHELD_TOOLS` (tools the CLI won't keep out
 * via `permissions.deny`) and `INJECTED_REMINDERS` (harness-injected text no user
 * setting suppresses) from the request before forwarding, and puts back the
 * message-level `cache_control` breakpoint the CLI intermittently drops (see
 * `cache-breakpoint.ts`, which carries the reasoning and its own retirement
 * trigger). Requests with nothing to edit are forwarded byte-for-byte.
 * `packages/core/src/filters.ts` holds the human-readable inventory the dashboard
 * renders — keep the two in sync.
 *
 * Run:   node proxy.ts
 * Point Claude Code at it:
 *   ANTHROPIC_BASE_URL=http://localhost:8787 claude
 *
 * Zero runtime dependencies — Node built-ins only. TypeScript is a devDependency:
 * Node runs this file directly by stripping the types, so the `claude-proxy` bin
 * needs no build step. Requires Node 22.18+ (unflagged type stripping).
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DeclinedGate, ensureMessageBreakpoint, estPrefixTokens, noteCacheRead } from './cache-breakpoint.ts';
import { resolveProxyPort } from './config.ts';
import { asList, asNumber, asRecord, asText, type JsonObject, type JsonValue, parseJson } from './json.ts';
import {
  type EntrySnapshot,
  snapshot as keepaliveSnapshot,
  type LastPing,
  MAX_DEADLINE_HOURS,
  noteRequest,
  pingNow,
  register as registerKeepalive,
  release as releaseKeepalive,
  setBearerSource,
  setUtilizationSource,
  startKeepalive,
  usageLiveUtilization,
  validateDeadlineHours,
} from './keepalive.ts';
import * as session from './session.ts';
import * as skim from './skim.ts';
import { identifyPrompt, type PromptIdentity, recordPrompt } from './system-prompt.ts';
import { bearerForAccount, noteAuth, startUsagePolling } from './usage-live.ts';
import {
  asArrayOf,
  type ContentBlock,
  type HeaderBag,
  type RequestBody,
  type ToolDefinition,
  type Usage,
  type WireMessage,
} from './wire.ts';

const PORT = resolveProxyPort();
const HOST = process.env.HOST ?? '127.0.0.1'; // localhost-only by default; set HOST="" to bind all interfaces
const UPSTREAM = 'api.anthropic.com';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Logs live at the repo root (shared with the dashboard server), not next to
// this file. Override with LOG_DIR to point elsewhere.
const LOG_DIR = process.env.LOG_DIR ?? path.join(HERE, '..', 'logs');

/**
 * Bytes per token for the audit report's display estimates, measured rather than
 * assumed. Real input tokens come from the response usage; this only ranks a
 * request before the reply arrives.
 *
 * Measured across 530 cold-start requests in the log window — `cacheRead` 0 and
 * `input` under 50, so `totalBytes / cacheCreation` is the ratio outright — out of
 * 50,122 logged requests: median 2.78 bytes per token, p10 2.71, p90 2.87. The
 * ratio is flat across the model line (opus-4-8 2.69, sonnet-5 2.80, fable-5 2.83,
 * opus-5 2.85), so one constant covers every model the proxy sees.
 *
 * The median rather than the bytes-weighted 2.876: a handful of requests run as
 * sparse as 9.67 bytes per token and pull a pooled figure away from the typical
 * request these estimates are shown against.
 *
 * Not the same number as `PREFIX_BYTES_PER_TOKEN` in `cache-breakpoint.ts`, which
 * takes a floor of the same corpus: a threshold inside a cost decision rounds
 * toward declining, a display estimate aims at the middle. The `bytes / 4` this
 * replaced understated every figure it fed by ~44%.
 */
const BYTES_PER_TOKEN = 2.78;
const estTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

/** count_tokens calls send content but get back only a number, never a reply.
 * A single turn fires many as housekeeping — pure noise here, so skip them. */
const isTokenCount = (reqPath: string): boolean => reqPath.includes('count_tokens');

/**
 * Whether this request is one a capture triple can be written for.
 *
 * A request that carried **no body** is not. `.request.txt` would be zero bytes
 * and the sidecar beside it prices an empty `{}`. Every zero-byte body on disk is
 * one of these — 32 of 2,735 triples on 2026-07-28, 23 of 1,281 on 2026-09-11,
 * all `HEAD /api/hello` health probes aimed at the proxy's port. They are still
 * forwarded upstream; they are just not written down.
 *
 * Only the pass-through path consults this. A skim hit cannot be one of these:
 * `skim.cacheable` requires `/v1/messages` with `stream: true`, which a bodyless
 * request has no way to say.
 */
export const isCapturable = (reqPath: string, body: Buffer): boolean => body.length > 0 && !isTokenCount(reqPath);

const REDACT = new Set(['authorization', 'x-api-key', 'api-key']);

/** Tools the CLI exempts from `permissions.deny` — the deny rule is silently
 * ignored and the schema ships every turn — so we strip them here instead.
 * Extend the set to withhold more unstrippable tools. */
const WITHHELD_TOOLS = new Set(['EndConversation']);

/** What one strip pass produced: the body to forward on, and what it took out. */
interface StripResult {
  reqJson: RequestBody | null;
  removed: string[];
}

/** Remove withheld tools from a parsed request body. Returns the original object
 * (same reference) when there's nothing to strip; otherwise a shallow copy with
 * a filtered `tools` array, plus the removed names. */
function stripWithheldTools(reqJson: RequestBody | null, withheld: Set<string> = WITHHELD_TOOLS): StripResult {
  const defs = asArrayOf<ToolDefinition>(reqJson?.tools);
  const removed = defs.filter((t) => withheld.has(t?.name ?? '')).map((t) => t.name ?? '');
  if (removed.length === 0) return { reqJson, removed };
  return { reqJson: { ...reqJson, tools: defs.filter((t) => !withheld.has(t?.name ?? '')) }, removed };
}

/** One kind of harness-injected text, and the pattern that finds it. */
interface InjectedReminder {
  id: string;
  label: string;
  pattern: RegExp;
}

/** Text the CLI harness injects into requests that no user setting can keep out —
 * there's no `permissions.deny` equivalent, and a CLAUDE.md instruction doesn't
 * reliably suppress it — so we strip it here instead. Each entry's `pattern` (a
 * global regex) is matched against every text block in `messages`. Anchor patterns
 * on stable phrasing at both ends so wording drift in the middle still matches.
 * Keep this inventory in sync with `packages/core/src/filters.ts`. */
const INJECTED_REMINDERS: InjectedReminder[] = [
  {
    id: 'task-tools',
    label: 'Task-tools nudge',
    pattern: /The task tools haven't been used recently\.[\s\S]*?ignore if not applicable\.?/g,
  },
];

/** Remove injected-reminder text from a parsed request body. Walks `messages`,
 * strips any matching text from string or `text`-block content, drops blocks left
 * empty, and drops messages left with no content. Returns the original object
 * (same reference) when nothing matched; otherwise a shallow copy with a rewritten
 * `messages` array, plus the ids of the reminders removed. */
function stripInjectedReminders(
  reqJson: RequestBody | null,
  reminders: InjectedReminder[] = INJECTED_REMINDERS,
): StripResult {
  if (asList(reqJson?.messages) === null) return { reqJson, removed: [] };

  const removed = new Set<string>();
  const strip = (text: string): string => {
    let out = text;
    let hit = false;
    for (const r of reminders) {
      const next = out.replace(r.pattern, '');
      r.pattern.lastIndex = 0; // stay safe if a pattern is ever declared without /g
      if (next !== out) {
        removed.add(r.id);
        hit = true;
      }
      out = next;
    }
    // Collapse the blank-line run a removed block leaves behind — but only when we
    // actually stripped, so untouched text is returned byte-for-byte.
    return hit ? out.replace(/\n{3,}/g, '\n\n') : out;
  };

  const nextMessages: WireMessage[] = [];
  for (const m of asArrayOf<WireMessage>(reqJson?.messages)) {
    const bare = asText(m?.content);
    if (bare !== null) {
      const stripped = strip(bare);
      if (stripped === bare) {
        nextMessages.push(m);
        continue;
      }
      const trimmed = stripped.trim();
      if (trimmed) nextMessages.push({ ...m, content: trimmed }); // else: emptied → drop the message
      continue;
    }
    if (asList(m?.content) === null) {
      nextMessages.push(m);
      continue;
    }
    let changed = false;
    const blocks: ContentBlock[] = [];
    for (const b of asArrayOf<ContentBlock>(m?.content)) {
      const text = asText(b?.text);
      if (b?.type === 'text' && text !== null) {
        const stripped = strip(text);
        if (stripped !== text) {
          changed = true;
          const trimmed = stripped.trim();
          if (trimmed) blocks.push({ ...b, text: trimmed }); // else: drop the emptied block
          continue;
        }
      }
      blocks.push(b);
    }
    if (!changed) {
      nextMessages.push(m);
      continue;
    }
    if (blocks.length) nextMessages.push({ ...m, content: blocks }); // else: no blocks left → drop
  }

  if (removed.size === 0) return { reqJson, removed: [] };
  return { reqJson: { ...reqJson, messages: nextMessages }, removed: [...removed] };
}

/** Strip hop-by-hop and encoding headers so the captured response is readable,
 * recompute content-length, and pass auth through untouched so the real request
 * still authenticates. */
function forwardHeaders(headers: http.IncomingHttpHeaders, body: Buffer): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  delete out.host;
  delete out.connection;
  delete out['accept-encoding']; // force identity so we can read the stream
  delete out['transfer-encoding'];
  delete out['content-length'];
  if (body.length > 0) out['content-length'] = String(body.length);
  return out;
}

function baseName(): string {
  const stamp = new Date().toISOString().replace(/:/g, '-').replace('.', '-').replace('Z', '');
  return `${stamp}_anthropic`;
}

// ---------------------------------------------------------------------------
// The audit: rank what's in the request
// ---------------------------------------------------------------------------

/** One tool's weight in the request. */
interface ToolRow {
  name: string;
  bytes: number;
  tokens: number;
}

/** Everything the ranked table and the sidecar are rendered from. */
interface Audit {
  toolRows: ToolRow[];
  toolCount: number;
  toolsBytes: number;
  systemBytes: number;
  totalBytes: number;
  realInputTokens: number | null;
  systemPrompt: PromptIdentity | null;
}

/** Measure every removable region of the request and rank the tools by size.
 * This is the whole point of the proxy — the numbers you cut against. */
function auditRequest(reqJson: RequestBody | null, realInputTokens: number | null): Audit {
  const tools = asArrayOf<ToolDefinition>(reqJson?.tools);
  const toolRows = tools
    .map((t) => {
      const bytes = Buffer.byteLength(JSON.stringify(t));
      return { name: t?.name ?? '(unnamed)', bytes, tokens: estTokens(bytes) };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const toolsBytes = toolRows.reduce((n, r) => n + r.bytes, 0);
  const systemBytes = reqJson?.system ? Buffer.byteLength(JSON.stringify(reqJson.system)) : 0;
  const totalBytes = Buffer.byteLength(JSON.stringify(reqJson ?? {}));

  return {
    toolRows,
    toolCount: toolRows.length,
    toolsBytes,
    systemBytes,
    totalBytes,
    realInputTokens,
    // Identity of the system prompt; its outline goes to the dedup store.
    systemPrompt: identifyPrompt(reqJson?.system),
  };
}

/** Who sent a request, as far as the headers and metadata say. Never any auth. */
interface SessionInfo {
  sessionId: string | null;
  app: string | null;
  userAgent: string | null;
  account: string | null;
  metadataSessionId: string | null;
  deviceId: string | null;
  /**
   * The transcript this request belongs to — the same id
   * {@link session.threadIdFor} names `logs/sessions/<threadId>.md` with. Absent (not
   * null) when the body has no user text to root on, so an unrootable request and a
   * sidecar written before this field read alike.
   */
  threadId?: string;
}

/** Reads sender identity from Claude Code's headers plus the `metadata.user_id`
 * blob (a JSON string carrying account/session/device ids). No auth is included. */
function extractSession(headers: HeaderBag | undefined, reqJson: RequestBody | null): SessionInfo {
  const h = headers ?? {};
  const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null;
  let account: string | null = null;
  let metadataSessionId: string | null = null;
  let device: string | null = null;
  const rawUserId = asText(reqJson?.metadata?.user_id);
  if (rawUserId !== null) {
    // A `user_id` that is not JSON leaves all three ids null.
    const ids = asRecord(parseJson(rawUserId));
    account = asText(ids?.account_uuid);
    metadataSessionId = asText(ids?.session_id);
    device = asText(ids?.device_id);
  }
  const sessionId = first(h['x-claude-code-session-id']);
  const info: SessionInfo = {
    sessionId,
    app: first(h['x-app']), // "-bg" suffix marks a background agent
    userAgent: first(h['user-agent']),
    account,
    metadataSessionId,
    deviceId: device,
  };
  const threadId = session.threadIdFor(sessionId, reqJson?.messages);
  if (threadId) info.threadId = threadId;
  return info;
}

/**
 * Rate-limit headers off the upstream *response* — how much of the subscription's
 * allowances is left. Kept verbatim (names lowercased) rather than parsed into
 * fixed fields, so a renamed or newly-added window still reaches the dashboard
 * without a proxy change. Only `anthropic-ratelimit-*` and `x-ratelimit-*` names
 * are copied, so no auth comes with them.
 */
function extractRateLimit(respHeaders: HeaderBag | undefined): Record<string, string> | null {
  if (!respHeaders) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(respHeaders)) {
    const key = name.toLowerCase();
    if (!key.startsWith('anthropic-ratelimit') && !key.startsWith('x-ratelimit')) continue;
    // Node lowercases header names and may hand back an array for repeats.
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** What the app-layer skim did for this request. */
interface SkimInfo {
  enabled: boolean;
  servedFromCache: boolean;
  savedInputTokens: number;
  cacheKey: string | null;
}

/** Everything a sidecar is built from — one request, its reply, and its audit. */
interface SidecarInput {
  timestamp: string;
  reqJson: RequestBody | null;
  statusCode: number;
  method: string;
  path: string;
  audit: Audit;
  inputTokens: number | null;
  usage: Usage | null;
  respModel?: string | null;
  headers?: HeaderBag;
  respHeaders?: HeaderBag;
  skim?: SkimInfo | null;
  /** Whether this request had a message cache breakpoint put back. */
  cacheBreakpointInjected?: boolean;
  /** Whether the CLI dropped the breakpoint on this request at all. */
  cacheBreakpointObserved?: boolean;
  /** The gate that declined an observed occurrence; null when none did. */
  cacheBreakpointDeclinedBy?: DeclinedGate | null;
}

/** The sidecar's own contract — the stable JSON shape tooling reads back. */
interface AuditSidecar {
  timestamp: string;
  model: string;
  endpoint: string;
  statusCode: number;
  session: SessionInfo;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; realInput: number };
  request: {
    toolCount: number;
    toolsBytes: number;
    systemBytes: number;
    totalBytes: number;
    /** Omitted when the request carried no system prompt. */
    system?: { hash: string; blocks: number; sections: number };
  };
  skim: SkimInfo;
  cacheBreakpointInjected: boolean;
  cacheBreakpointObserved: boolean;
  cacheBreakpointDeclinedBy: DeclinedGate | null;
  tools: { name: string; bytes: number; estTokens: number }[];
  /** Omitted when upstream sent none, so a sidecar never implies a reading it lacks. */
  rateLimit?: Record<string, string>;
}

/** Structured sidecar next to each `.md` — the machine-readable facts the daily
 * usage-summary reads (token/cost, context bloat, activity). The `.md` stays for
 * humans; this is stable JSON for tooling. Auth is never included. */
function writeAuditSidecar({
  timestamp,
  reqJson,
  statusCode,
  method,
  path: reqPath,
  audit,
  inputTokens,
  usage,
  respModel,
  headers,
  respHeaders,
  skim: skimInfo,
  cacheBreakpointInjected,
  cacheBreakpointObserved,
  cacheBreakpointDeclinedBy,
}: SidecarInput): string {
  const u = usage ?? {};
  const rateLimit = extractRateLimit(respHeaders);
  const sidecar: AuditSidecar = {
    timestamp,
    model: asText(reqJson?.model) ?? respModel ?? 'unknown',
    endpoint: `${method} ${reqPath}`,
    statusCode,
    session: extractSession(headers, reqJson),
    tokens: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      realInput: inputTokens ?? 0,
    },
    request: {
      toolCount: audit.toolCount,
      toolsBytes: audit.toolsBytes,
      systemBytes: audit.systemBytes,
      totalBytes: audit.totalBytes,
    },
    // App-layer skim (not Anthropic's prefix cache); recorded on every request so
    // hit-rate + saved spend are computable from the sidecar.
    skim: skimInfo ?? { enabled: skim.skimEnabled(), servedFromCache: false, savedInputTokens: 0, cacheKey: null },
    // All three recorded on every request. The observation carries the retirement
    // trigger, not the injection — a run of zero injections also happens while the
    // CLI still drops the breakpoint and a gate declines. See `cache-breakpoint.ts`.
    cacheBreakpointInjected: cacheBreakpointInjected ?? false,
    cacheBreakpointObserved: cacheBreakpointObserved ?? false,
    cacheBreakpointDeclinedBy: cacheBreakpointDeclinedBy ?? null,
    tools: audit.toolRows.map((r) => ({ name: r.name, bytes: r.bytes, estTokens: r.tokens })),
  };
  if (audit.systemPrompt) {
    sidecar.request.system = {
      hash: audit.systemPrompt.hash,
      blocks: audit.systemPrompt.blocks,
      sections: audit.systemPrompt.sections,
    };
  }
  // Omitted when upstream sent none, so a sidecar never implies a reading it lacks.
  if (rateLimit) sidecar.rateLimit = rateLimit;
  return JSON.stringify(sidecar, null, 2);
}

/** The ranked table, as Markdown. The hero of the whole document. */
function renderAudit(a: Audit): string {
  const pct = (b: number) => (a.totalBytes ? ((b / a.totalBytes) * 100).toFixed(1) : '0.0');
  const rows = a.toolRows
    .map((r) => `| ${r.name} | ${r.bytes.toLocaleString()} | ~${r.tokens.toLocaleString()} | ${pct(r.bytes)}% |`)
    .join('\n');

  return [
    '<audit>',
    '',
    a.realInputTokens != null
      ? `**${a.realInputTokens.toLocaleString()} input tokens** billed for this request (from the response usage).`
      : '',
    '',
    `- **tools**: ${a.toolCount} definitions, ${a.toolsBytes.toLocaleString()} bytes (~${estTokens(a.toolsBytes).toLocaleString()} tokens)`,
    `- **system prompt**: ${a.systemBytes.toLocaleString()} bytes (~${estTokens(a.systemBytes).toLocaleString()} tokens)`,
    `- **total request**: ${a.totalBytes.toLocaleString()} bytes`,
    '',
    '**Tools, ranked by size — this is your cut list:**',
    '',
    '| tool | bytes | ~tokens | % of request |',
    '| --- | --: | --: | --: |',
    rows,
    '',
    '</audit>',
  ].join('\n');
}

/** The same ranking, compact, for the terminal — so you see the bloat live. */
function printAudit(a: Audit, base: string): void {
  const top = a.toolRows.slice(0, 12);
  const w = Math.max(4, ...top.map((r) => r.name.length));
  console.log(
    `\n[agent-proxy] ${a.toolCount} tools · ${a.toolsBytes.toLocaleString()} tool bytes` +
      (a.realInputTokens != null ? ` · ${a.realInputTokens.toLocaleString()} real input tokens` : ''),
  );
  for (const r of top) {
    console.log(`  ${r.name.padEnd(w)}  ${String(r.bytes).padStart(7)} B  ~${r.tokens} tok`);
  }
  if (a.toolRows.length > top.length) console.log(`  … ${a.toolRows.length - top.length} more`);
  console.log(`  logs/${base}.md\n`);
}

// ---------------------------------------------------------------------------
// Readable Markdown render (Anthropic /messages only)
// ---------------------------------------------------------------------------

const fenceJson = (v: JsonValue | undefined): string => `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;
const fence = (t: string, lang = ''): string => `\`\`\`${lang}\n${t}\n\`\`\``;

function blockText(b: JsonValue | undefined): string {
  const bare = asText(b);
  if (bare !== null) return bare;
  const block = asRecord(b);
  return block?.type === 'text' ? (asText(block.text) ?? '') : '';
}

function renderSystem(system: JsonValue | undefined): string {
  const bare = asText(system);
  if (bare !== null) return bare;
  const blocks = asList(system);
  if (blocks === null) return fenceJson(system);
  return blocks
    .map((b) => blockText(b) + (asRecord(b)?.cache_control ? '\n\n<!-- cache_control breakpoint -->' : ''))
    .join('\n\n');
}

function renderTools(tools: ToolDefinition[]): string {
  const rendered = tools.map((t) => {
    const lines = [`### ${t.name ?? '(unnamed tool)'}`, ''];
    if (t.description) lines.push(t.description, '');
    if (t.input_schema) lines.push(fenceJson(t.input_schema));
    return lines.join('\n');
  });
  return ['<tools>', '', rendered.join('\n\n'), '', '</tools>'].join('\n');
}

function imagePlaceholder(b: ContentBlock): string {
  const src = b.source ?? {};
  const bytes = asText(src.data)?.length ?? 0;
  return `\`[image: ${String(src.media_type ?? 'unknown')}, ${bytes} base64 chars — full data in .request.txt]\``;
}

function renderContent(content: JsonValue | undefined): string {
  const bare = asText(content);
  if (bare !== null) return bare;
  if (asList(content) === null) return fenceJson(content);
  return asArrayOf<ContentBlock>(content)
    .map((b) => {
      switch (b?.type) {
        case 'text':
          return b.text ?? '';
        case 'tool_use':
          return [
            `<tool-use name="${b.name}" id="${b.id ?? ''}">`,
            '',
            fenceJson(b.input ?? {}),
            '',
            '</tool-use>',
          ].join('\n');
        case 'tool_result': {
          const bareResult = asText(b.content);
          const inner =
            bareResult ??
            (asList(b.content) === null
              ? fenceJson(b.content)
              : asArrayOf<ContentBlock>(b.content)
                  .map((x) => (x?.type === 'image' ? imagePlaceholder(x) : blockText(x) || fenceJson(x)))
                  .join('\n\n'));
          return [
            `<tool-result tool-use-id="${b.tool_use_id ?? ''}" is-error="${!!b.is_error}">`,
            '',
            inner,
            '',
            '</tool-result>',
          ].join('\n');
        }
        case 'image':
          return imagePlaceholder(b);
        case 'thinking':
          return ['<thinking>', '', b.thinking ?? '', '', '</thinking>'].join('\n');
        default:
          return fenceJson(b);
      }
    })
    .join('\n\n');
}

function renderMessages(messages: JsonValue | undefined): string {
  if (asList(messages) === null) return '<messages></messages>';
  const rendered = asArrayOf<WireMessage>(messages).map((m, i) =>
    [`<message index="${i + 1}" role="${m.role ?? 'unknown'}">`, '', renderContent(m.content), '', '</message>'].join(
      '\n',
    ),
  );
  return ['<messages>', '', rendered.join('\n\n'), '', '</messages>'].join('\n');
}

/** Sum the three billed input components into the single "real input" figure. */
function sumInputTokens(usage: Usage | null | undefined): number | null {
  return usage
    ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    : null;
}

/** One decoded SSE frame, as far as the reassembly reads it. */
interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; name?: string; id?: string };
  delta?: { text?: string; partial_json?: string; thinking?: string; stop_reason?: string };
  message?: { usage?: Usage; model?: string };
  usage?: Usage;
}

/** A reassembled reply: the readable Markdown plus the facts behind it. */
interface DecodedResponse {
  markdown: string;
  inputTokens: number | null;
  usage: Usage | null;
  model: string | null;
}

/** Reassemble the streamed SSE response so we can read the reply — and pull the
 * real input-token count out of the usage events. */
function decodeResponse(raw: string): DecodedResponse {
  const events: StreamEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    const payload = m?.[1];
    if (payload === undefined || payload === '[DONE]' || payload.trim() === '') continue;
    try {
      // SAFETY: every `StreamEvent` field is optional and the reassembly branches on
      // `type` first, so an unrecognised frame contributes nothing rather than a
      // wrong type; a frame that is not JSON throws into the `catch`.
      events.push(JSON.parse(payload) as StreamEvent);
    } catch {
      /* skip */
    }
  }

  // Non-streaming path: body is a single JSON message object (not SSE) with
  // usage at the top level.
  if (events.length === 0) {
    try {
      // SAFETY: every field claimed is optional and the guard below requires `usage`
      // or `content` first, so a body that is JSON but not a message object falls
      // through to the raw fence.
      const obj = JSON.parse(raw) as {
        usage?: Usage;
        content?: JsonValue;
        stop_reason?: string;
        model?: string;
      } | null;
      if (obj && (obj.usage || obj.content)) {
        const usage = obj.usage ?? null;
        const parts: string[] = [];
        if (obj.stop_reason) parts.push(`- **stop reason**: ${obj.stop_reason}`);
        if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`, '');
        const rendered = renderContent(obj.content ?? []);
        if (rendered) parts.push(rendered);
        return {
          markdown: parts.length ? parts.join('\n\n') : fence(raw),
          inputTokens: sumInputTokens(usage),
          usage,
          model: obj.model ?? null,
        };
      }
    } catch {
      /* not JSON either — fall through to the raw fence below */
    }
  }

  const blocks: Record<number, { type: string; text: string; name?: string; id?: string }> = {};
  let stopReason: string | undefined;
  let usage: Usage | undefined;
  let model: string | undefined;
  for (const ev of events) {
    const index = ev.index;
    if (ev.type === 'content_block_start' && index !== undefined) {
      blocks[index] = {
        type: ev.content_block?.type ?? 'text',
        text: '',
        name: ev.content_block?.name,
        id: ev.content_block?.id,
      };
    } else if (ev.type === 'content_block_delta' && index !== undefined && blocks[index]) {
      const d = ev.delta ?? {};
      blocks[index].text += d.text ?? d.partial_json ?? d.thinking ?? '';
    } else if (ev.type === 'message_start') {
      if (ev.message?.usage) usage = { ...ev.message.usage, ...usage };
      if (ev.message?.model) model = ev.message.model;
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage) usage = { ...usage, ...ev.usage };
    }
  }
  const parts: string[] = [];
  if (stopReason) parts.push(`- **stop reason**: ${stopReason}`);
  if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`, '');
  for (const i of Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b)) {
    const b = blocks[i];
    if (!b) continue;
    if (b.type === 'text') parts.push(['<assistant-text>', '', b.text, '', '</assistant-text>'].join('\n'));
    else if (b.type === 'thinking') parts.push(['<thinking>', '', b.text, '', '</thinking>'].join('\n'));
    else if (b.type === 'tool_use')
      parts.push(
        [`<tool-use name="${b.name}" id="${b.id ?? ''}">`, '', fence(b.text || '{}', 'json'), '', '</tool-use>'].join(
          '\n',
        ),
      );
  }
  return {
    markdown: parts.length ? parts.join('\n\n') : fence(raw),
    inputTokens: sumInputTokens(usage),
    usage: usage ?? null,
    model: model ?? null,
  };
}

/** The request context the Markdown document is headed with. */
interface RenderContext {
  reqJson: RequestBody | null;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  headers: HeaderBag;
}

function renderMarkdown(c: RenderContext, audit: Audit, responseMd: string): string {
  const headers = Object.entries(c.headers).map(
    ([k, v]) => `${k}: ${REDACT.has(k.toLowerCase()) ? '[REDACTED]' : Array.isArray(v) ? v.join(', ') : (v ?? '')}`,
  );
  const req = c.reqJson;
  const parts = [
    [
      '<meta>',
      '',
      `- **timestamp**: ${c.timestamp}`,
      `- **model**: ${String(req?.model ?? 'unknown')}`,
      `- **endpoint**: ${c.method} ${c.path}`,
      `- **upstream status**: ${c.statusCode}`,
      '',
      '</meta>',
    ].join('\n'),
    renderAudit(audit),
    ['<headers>', '', '```', ...headers, '```', '', '</headers>'].join('\n'),
  ];
  if (req?.system != null)
    parts.push(['<system-prompt>', '', renderSystem(req.system), '', '</system-prompt>'].join('\n'));
  const tools = asArrayOf<ToolDefinition>(req?.tools);
  if (tools.length) parts.push(renderTools(tools));
  parts.push(renderMessages(req?.messages));
  parts.push(`<response>\n\n${responseMd}\n\n</response>`);
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** A caught value is `unknown`; this is the message it would have shown. */
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// ---------------------------------------------------------------------------
// Keep-alive: the control endpoint, the capture, and the status mirror
// ---------------------------------------------------------------------------

/**
 * The control endpoint the `/warm` command registers a session through. The outward
 * name keeps the `warm` word; the module behind it deliberately does not, because
 * `cache-breakpoint.ts` already owns that word inside this package. See ADR 0077 §5.
 */
const WARM_PATH = '/__warm';

/**
 * The sub-path that sends one ping now, rather than at the next padded interval.
 *
 * A path of its own rather than another verb on {@link WARM_PATH}: `POST` there means
 * "register this session", and a forced ping is an action on an entry that already
 * exists. It takes the same loopback rule and the same `sessionId` shapes, so from the
 * outside it reads as one endpoint with one extra thing it can be asked to do.
 */
const WARM_PING_PATH = '/__warm/ping';

/** The status mirror, written beside `usage-live.json` and in the same shape. */
export const WARM_STATUS_FILE = 'warm.json';

/** How often the mirror republishes. Unref'd, exactly as the usage poll is. */
const WARM_STATUS_INTERVAL_MS = 60_000;

/**
 * Mirrors `CACHE_READ_METERING_WEIGHT` in `stacks/claude/core/src/usage-limits.ts`.
 *
 * The duplication is the price of `proxy/` shipping no runtime dependencies — exactly
 * as `system-prompt.ts` mirrors `packages/core/src/wire-prompt.ts` — and
 * `warm.test.ts` reads that file's own literal and pins this one to it, so the two
 * cannot drift apart silently.
 *
 * A wrong weight is quiet here: `usageUnits` in `warm.json` is the only local record of
 * what the pings spent, since ADR 0077 keeps a ping out of the audit corpus entirely,
 * and ADR 0078 settles the resume rate against exactly that figure.
 */
export const CACHE_READ_METERING_WEIGHT = 0.02;

/** Weighted usage units for a cache-read count, rounded to something readable. */
const usageUnitsFor = (cacheReadTokens: number): number =>
  Math.round(cacheReadTokens * CACHE_READ_METERING_WEIGHT * 1000) / 1000;

/**
 * Whether a remote address is this machine's own loopback.
 *
 * **The control endpoint is bound to loopback whatever `HOST` says.** The proxy can be
 * told to bind every interface with `HOST=""`, and an endpoint that registers sessions,
 * cancels them and lists them must not follow it out there. IPv4 loopback is the whole
 * `127.0.0.0/8` block rather than `127.0.0.1` alone, and Node reports a v4 peer on a
 * dual-stack listener as `::ffff:127.0.0.1`, so both forms are accepted. An address
 * Node could not report at all is not loopback.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const host = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (host === '::1') return true;
  return /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host)?.[1] === '127';
}

/** Whether a request URL addresses the control endpoint, query string and all. */
export function isWarmControlPath(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? url;
  return pathname === WARM_PATH || pathname === WARM_PING_PATH;
}

/** Whether that control call is the forced-ping one, which is answered asynchronously. */
export function isWarmPingPath(url: string): boolean {
  return (url.split('?', 1)[0] ?? url) === WARM_PING_PATH;
}

/** One control-endpoint call, as `handle()` reads it off the request. */
export interface WarmControlRequest {
  method: string;
  url: string;
  remoteAddress: string | null | undefined;
  body: string;
}

/** What to reply with. Always JSON, and never an echo of a stored body. */
export interface WarmControlReply {
  statusCode: number;
  payload: JsonObject;
  /** Whether the call changed the registry, so `handle()` knows to republish. */
  changed: boolean;
}

/**
 * Answer one call to the control endpoint.
 *
 * Pure with respect to the request — it takes the method, the URL, the peer address and
 * the raw body rather than a socket — so the loopback rule and the clamp are testable
 * without standing a server up. `handle()` calls it before anything else touches the
 * request, so neither `isTokenCount` nor the skim gate ever sees a control call.
 */
export function warmControl({ method, url, remoteAddress, body }: WarmControlRequest): WarmControlReply {
  if (!isLoopbackAddress(remoteAddress)) {
    return { statusCode: 403, payload: { error: 'the warm control endpoint is loopback-only' }, changed: false };
  }

  const verb = method.toUpperCase();
  if (verb === 'GET') return { statusCode: 200, payload: warmStatusDocument(), changed: false };

  const parsed = asRecord(parseJson(body));
  const query = new URL(url, 'http://127.0.0.1').searchParams;
  const sessionId = asText(parsed?.sessionId) ?? query.get('sessionId');

  if (verb === 'POST') {
    if (!sessionId) return { statusCode: 400, payload: { error: 'sessionId is required' }, changed: false };
    // Absent `hours`, the registration falls back to MAX_DEADLINE_HOURS — the default
    // ADR 0078 ships knowing the measured resume rate sits below break-even. A named
    // `hours` is honoured however large; that constant no longer caps it.
    const requested = asNumber(parsed?.hours) ?? Number(query.get('hours') ?? MAX_DEADLINE_HOURS);
    const hours = validateDeadlineHours(requested);
    if (hours === null) {
      return { statusCode: 400, payload: { error: 'hours must be a finite number above zero' }, changed: false };
    }
    const result = registerKeepalive({ sessionKey: sessionId, hours });
    if (!result.ok) {
      return { statusCode: 400, payload: { error: result.reason ?? 'registration refused' }, changed: false };
    }
    return {
      statusCode: 200,
      payload: {
        ok: true,
        sessionId,
        // `pending` until a real request matches it, never `armed` on this reply:
        // a registration is a handshake rather than an assertion. See ADR 0075.
        state: result.state ?? 'pending',
        hours,
        requestedHours: requested,
        deadline: result.deadline === undefined ? null : new Date(result.deadline).toISOString(),
      },
      changed: true,
    };
  }

  if (verb === 'DELETE') {
    if (!sessionId) return { statusCode: 400, payload: { error: 'sessionId is required' }, changed: false };
    const released = releaseKeepalive(sessionId);
    return { statusCode: 200, payload: { ok: true, sessionId, released }, changed: released };
  }

  return { statusCode: 405, payload: { error: `unsupported method ${verb}` }, changed: false };
}

/**
 * One ping's counts as the control endpoint and the mirror both report them.
 *
 * Counts, a status code and an instant — the same publishable surface ADR 0077 §3 allows
 * everywhere else here, and nothing from the reply body beyond the numbers.
 */
function pingReport(last: LastPing): JsonObject {
  return {
    at: new Date(last.at).toISOString(),
    statusCode: last.statusCode,
    inputTokens: last.inputTokens,
    cacheCreationTokens: last.cacheCreationTokens,
    cacheReadTokens: last.cacheReadTokens,
    outputTokens: last.outputTokens,
    usageUnits: usageUnitsFor(last.cacheReadTokens),
  };
}

/**
 * The question a forced ping is asked, answered in one word.
 *
 * **This is the decision rule, written where the person running the test reads it** rather
 * than left for them to derive from four numbers:
 *
 * - `cache-hit` — the ping read cached tokens. The keepalive is doing its job, and a
 *   cumulative count of zero beside this was a reporting fault.
 * - `paid-full-price` — the ping reached the upstream and was billed for the prefix
 *   without reading the cache. The registration is cost with no benefit; release it.
 * - `no-usage-reported` — 2xx carrying no token counts this could read. A fault in the
 *   reading rather than a verdict on the cache.
 * - `refused` — the upstream did not answer 2xx. `statusCode` is the whole story.
 */
function pingVerdict(last: LastPing | null): string {
  if (last === null) return 'no-ping-sent';
  if (last.statusCode < 200 || last.statusCode >= 300) return 'refused';
  if (last.cacheReadTokens > 0) return 'cache-hit';
  if (last.inputTokens > 0) return 'paid-full-price';
  return 'no-usage-reported';
}

/**
 * Answer one call to the forced-ping sub-path: send a ping for the named session now and
 * report exactly what came back.
 *
 * Asynchronous, which is why it is separate from {@link warmControl} rather than another
 * verb inside it — that function stays synchronous and every one of its callers stays
 * unchanged.
 *
 * A refusal is 404 when no registration exists under that id and 409 when one does but is
 * in no state to ping — pending, stopped, past its deadline, or holding no credential.
 * Both carry the reason as prose, exactly as the sibling refusals here do.
 */
export async function warmPingControl({
  method,
  url,
  remoteAddress,
  body,
}: WarmControlRequest): Promise<WarmControlReply> {
  if (!isLoopbackAddress(remoteAddress)) {
    return { statusCode: 403, payload: { error: 'the warm control endpoint is loopback-only' }, changed: false };
  }

  const verb = method.toUpperCase();
  if (verb !== 'POST') {
    return { statusCode: 405, payload: { error: `unsupported method ${verb}` }, changed: false };
  }

  const parsed = asRecord(parseJson(body));
  const query = new URL(url, 'http://127.0.0.1').searchParams;
  const sessionId = asText(parsed?.sessionId) ?? query.get('sessionId');
  if (!sessionId) return { statusCode: 400, payload: { error: 'sessionId is required' }, changed: false };

  const result = await pingNow(sessionId);
  if (!result.ok) {
    return {
      // `state` is absent only when the registry held nothing under that id at all.
      statusCode: result.state === undefined ? 404 : 409,
      payload: {
        ok: false,
        sessionId,
        state: result.state ?? null,
        error: result.reason ?? 'no ping was sent',
      },
      changed: false,
    };
  }

  const last = result.lastPing ?? null;
  return {
    statusCode: 200,
    payload: {
      ok: true,
      sessionId,
      state: result.state ?? null,
      ping: last === null ? null : pingReport(last),
      verdict: pingVerdict(last),
    },
    // The ping moved `lastActivity` and the counters, so the mirror is now stale.
    changed: true,
  };
}

/**
 * Sessions observed resuming — a real request arriving for an entry whose pings had
 * already fired.
 *
 * `keepalive.ts` has no `resumed` stop reason and deliberately does not grow one:
 * resuming is not the entry retiring, it is the user coming back, and the only place
 * that is observable is here, where the real request arrives. ADR 0078 settles the
 * feature's whole premise against this count, so it is recorded rather than inferred
 * later from a gap in the logs.
 */
const resumedSessions = new Map<string, { at: number; afterPings: number }>();

/** Test seam, as `_resetKeepalive` and `resetAuth` are for their own modules. */
export function _resetWarmStatus(): void {
  resumedSessions.clear();
}

/**
 * The session id a warm registration is matched against: the header's, else the
 * `metadata.user_id` blob's. ADR 0075 measured the two equal across 3,291 requests with
 * zero disagreement and no one-sided case, which is what justifies the coalesce.
 */
export function warmSessionKey(sender: SessionInfo): string | null {
  return sender.sessionId ?? sender.metadataSessionId;
}

/**
 * Fold a real forwarded request into the registry, and notice a resume.
 *
 * `reqJson` is the **forwarded** body rather than the raw one: `handle()` rewrites that
 * object in place for every strip and for an injected breakpoint, and `forwardBody` is
 * that same object serialized — so these are the bytes upstream actually cached, which
 * is the only thing a ping can usefully replay.
 *
 * `noteRequest` answers false for a session nobody registered, and that is the whole
 * guard: an unregistered session costs one `Map.get`, stores nothing, and never reaches
 * the snapshot below. That is what keeps the feature off the hot path for everyone who
 * never asked for it.
 */
export function noteWarmRequest(args: {
  sessionKey: string | null;
  account: string | null;
  reqJson: RequestBody | null;
  headers: HeaderBag;
  startedAt: number;
}): boolean {
  const took = noteRequest({
    sessionKey: args.sessionKey,
    account: args.account,
    body: args.reqJson,
    headers: args.headers,
    startedAt: args.startedAt,
  });
  const key = args.sessionKey;
  if (!took || key === null) return false;
  const entry = keepaliveSnapshot().find((e) => e.sessionKey === key);
  if (entry !== undefined && entry.pingsSent > 0 && !resumedSessions.has(key)) {
    resumedSessions.set(key, { at: args.startedAt, afterPings: entry.pingsSent });
  }
  return true;
}

/**
 * The terminal record for one entry as `warm.json` reports it: `resumed` when the user
 * came back, `expired` when the entry ran out of time or was never matched at all, and
 * `stopped-<reason>` for every other retirement.
 *
 * **`resumed` outranks a later retirement**, because it is the event ADR 0078 measures:
 * an entry that was resumed and then hit its deadline still resumed, and reporting it
 * as `expired` would undercount exactly the figure the record needs.
 */
function warmOutcome(entry: EntrySnapshot): string | null {
  if (resumedSessions.has(entry.sessionKey)) return 'resumed';
  const reason = entry.outcome?.reason;
  if (reason === undefined) return null;
  return reason === 'deadline' || reason === 'unmatched' ? 'expired' : `stopped-${reason}`;
}

/**
 * The status document, built from `snapshot()` alone.
 *
 * **Status only, by construction rather than by filtering**: `snapshot()` carries no
 * body, no headers and no credential, so there is nothing here to redact. Counts,
 * timestamps and reasons — the whole publishable surface ADR 0077 §3 allows.
 */
export function warmStatusDocument(now = Date.now()): JsonObject {
  const entries = keepaliveSnapshot();
  const iso = (at: number): string => new Date(at).toISOString();

  const rows = entries.map((entry) => {
    const row: JsonObject = {
      sessionKey: entry.sessionKey,
      account: entry.account,
      state: entry.state,
      pingsSent: entry.pingsSent,
      cacheReadTokens: entry.cacheReadTokens,
      usageUnits: usageUnitsFor(entry.cacheReadTokens),
      ttlMs: entry.ttlMs,
      registeredAt: iso(entry.registeredAt),
      lastActivity: iso(entry.lastActivity),
      deadline: iso(entry.deadline),
      outcome: warmOutcome(entry),
    };
    // What the last ping actually read, beside the cumulative count. A `cacheReadTokens`
    // of zero says nothing on its own about why; these four numbers and the verdict do.
    if (entry.lastPing !== null) {
      row.lastPing = pingReport(entry.lastPing);
      row.lastPingVerdict = pingVerdict(entry.lastPing);
    }
    // One short clause — a status code, a count. Never a body, prompt or credential.
    if (entry.outcome?.detail !== undefined) row.outcomeDetail = entry.outcome.detail;
    const resumed = resumedSessions.get(entry.sessionKey);
    if (resumed !== undefined) {
      row.resumedAt = iso(resumed.at);
      row.resumedAfterPings = resumed.afterPings;
    }
    return row;
  });

  const cacheReadTokens = entries.reduce((n, e) => n + e.cacheReadTokens, 0);
  return {
    updatedAt: iso(now),
    entries: rows,
    totals: {
      entries: entries.length,
      pending: entries.filter((e) => e.state === 'pending').length,
      armed: entries.filter((e) => e.state === 'armed').length,
      stopped: entries.filter((e) => e.state === 'stopped').length,
      resumed: entries.filter((e) => resumedSessions.has(e.sessionKey)).length,
      pingsSent: entries.reduce((n, e) => n + e.pingsSent, 0),
      cacheReadTokens,
      usageUnits: usageUnitsFor(cacheReadTokens),
    },
  };
}

/**
 * Publish the mirror: build the document, write it to a `.tmp` sibling, rename it into
 * place. The rename is the point — it is atomic, so no reader ever sees half a
 * document, and it is what wakes the server's existing log-directory SSE watcher,
 * exactly as `pollOnce` writes `usage-live.json`.
 *
 * Writes nothing at all while no session has ever registered and no file already
 * exists, so the feature leaves no trace for anyone who never asked for it.
 */
export function writeWarmStatus(logDir: string, now = Date.now()): boolean {
  const dest = path.join(logDir, WARM_STATUS_FILE);
  if (keepaliveSnapshot().length === 0 && !fs.existsSync(dest)) return false;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(warmStatusDocument(now), null, 2));
    fs.renameSync(tmp, dest);
    return true;
  } catch (cause) {
    console.warn(`[agent-proxy] warm status write failed: ${errorMessage(cause)}`);
    return false;
  }
}

/** Republish the mirror on a timer. Unref'd, so it never holds the process open. */
export function startWarmStatusMirror(
  logDir: string,
  { intervalMs = WARM_STATUS_INTERVAL_MS }: { intervalMs?: number } = {},
): () => void {
  const timer = setInterval(() => {
    writeWarmStatus(logDir);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const reqPath = req.url ?? '/';
  // The instant the request began. A cached prefix's own lifetime is measured from the
  // start of the request that reads or writes it, so this is what a keep-alive entry
  // has to time its padded interval from — not the instant the reply came back.
  const startedAt = Date.now();
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // ---- The keep-alive control endpoint, answered before anything else looks ----
    // Ahead of `noteAuth`, ahead of the body parse, ahead of `isTokenCount` and ahead
    // of the skim gate. Returning here is what keeps a control call out of all of them,
    // rather than each one separately learning to exclude it — the same reason ADR 0077
    // routes a ping around `handle()` instead of listing what it must skip.
    if (isWarmControlPath(reqPath)) {
      const control: WarmControlRequest = {
        method: req.method ?? 'GET',
        url: reqPath,
        remoteAddress: req.socket.remoteAddress,
        body: body.toString('utf8'),
      };
      const answer = (reply: WarmControlReply): void => {
        res.writeHead(reply.statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.payload));
        if (reply.changed) writeWarmStatus(LOG_DIR);
      };
      // The forced ping is the one control call that waits on the upstream, so it is the
      // one answered from a promise. Everything else stays synchronous.
      if (isWarmPingPath(reqPath)) {
        void warmPingControl(control).then(answer, (cause: unknown) => {
          // Never interpolate the cause: a ping's request error can carry the credential.
          console.warn(`[agent-proxy] forced ping failed: ${errorMessage(cause)}`);
          answer({ statusCode: 500, payload: { error: 'the ping could not be sent' }, changed: false });
        });
        return;
      }
      answer(warmControl(control));
      return;
    }

    const timestamp = new Date().toISOString();
    const base = baseName();

    // Parse the request body once — the skim gate and the logging both need it.
    let reqJson: RequestBody | null = null;
    try {
      // SAFETY: every `RequestBody` field is optional and decoded through `json.ts`
      // before use, so a body that parses but is not a `/v1/messages` request reads as
      // absent fields; one that is not JSON throws into the `catch`.
      reqJson = JSON.parse(body.toString('utf8')) as RequestBody;
    } catch {
      /* non-JSON body */
    }

    // The session this request belongs to, as the cache-breakpoint ledger keys it.
    const sender = extractSession(req.headers, reqJson);
    const sessionKey = warmSessionKey(sender);

    // Kept in memory for the usage poll and for a keep-alive ping; never logged or
    // written to a sidecar. The account is what scopes the bearer — ADR 0076 lets a
    // ping borrow only within one `account_uuid` and never across — so this is noted
    // here, once the body is parsed and the account is known, rather than on the way in.
    noteAuth(req.headers, sender.account);

    // Strip what the CLI can't keep out itself — withheld tools and injected
    // reminders — then put back the message-level cache breakpoint it sometimes
    // drops, re-serializing only when something changed. `forwardBody` is what we
    // send, key, and log from here on.
    let forwardBody = body;
    let breakpointInjected = false;
    let breakpointObserved = false;
    let breakpointDeclinedBy: DeclinedGate | null = null;
    if (reqJson) {
      const notes: string[] = [];
      const wt = stripWithheldTools(reqJson);
      if (wt.removed.length > 0) {
        reqJson = wt.reqJson;
        notes.push(`tools: ${wt.removed.join(', ')}`);
      }
      const ir = stripInjectedReminders(reqJson);
      if (ir.removed.length > 0) {
        reqJson = ir.reqJson;
        notes.push(`reminders: ${ir.removed.join(', ')}`);
      }
      // Before `skim.keyFor(forwardBody)` below, so the key covers the body
      // actually sent — an injected request keys differently than it would have
      // and takes a one-time miss. See `cache-breakpoint.ts`.
      if (!isTokenCount(reqPath)) {
        const bp = ensureMessageBreakpoint(reqJson, { sessionKey });
        breakpointObserved = bp.observed;
        breakpointDeclinedBy = bp.declinedBy;
        if (bp.injected) {
          reqJson = bp.reqJson;
          breakpointInjected = true;
        }
      }
      if (notes.length > 0 || breakpointInjected) {
        forwardBody = Buffer.from(JSON.stringify(reqJson), 'utf8');
      }
      if (notes.length > 0) console.log(`[agent-proxy] stripped ${notes.join(' · ')} from request`);
      if (breakpointInjected) console.log('[agent-proxy] injected a message cache_control breakpoint');
    }

    const skimDir = skim.cacheDir(LOG_DIR);
    const canSkim = !isTokenCount(reqPath) && skim.cacheable(reqPath, reqJson);
    const cacheKey = canSkim ? skim.keyFor(forwardBody) : null;

    // ---- Skim hit: replay the stored reply and never call Anthropic ----
    if (canSkim && cacheKey) {
      const hit = skim.lookup(skimDir, cacheKey);
      if (hit) {
        // Stored as upstream sent it, and Node hands back an array for a repeated
        // header — content-type is single-valued, so join rather than drop.
        const storedType = hit.meta.contentType;
        res.writeHead(hit.meta.statusCode ?? 200, {
          'content-type': (Array.isArray(storedType) ? storedType.join(', ') : storedType) ?? 'text/event-stream',
        });
        res.end(hit.body);
        try {
          const { markdown, inputTokens, model: respModel } = decodeResponse(hit.body.toString('utf8'));
          const saved = hit.meta.inputTokens ?? inputTokens ?? 0;
          const statusCode = hit.meta.statusCode ?? 200;
          const audit = auditRequest(reqJson ?? {}, saved);
          const skimInfo: SkimInfo = { enabled: true, servedFromCache: true, savedInputTokens: saved, cacheKey };
          fs.mkdirSync(LOG_DIR, { recursive: true });
          recordPrompt(LOG_DIR, audit.systemPrompt);
          fs.writeFileSync(path.join(LOG_DIR, `${base}.request.txt`), forwardBody.toString('utf8'));
          fs.writeFileSync(
            path.join(LOG_DIR, `${base}.md`),
            renderMarkdown(
              {
                reqJson,
                timestamp,
                method: req.method ?? 'POST',
                path: reqPath,
                statusCode,
                headers: req.headers,
              },
              audit,
              markdown,
            ),
          );
          fs.writeFileSync(
            path.join(LOG_DIR, `${base}.audit.json`),
            writeAuditSidecar({
              timestamp,
              reqJson,
              statusCode,
              method: req.method ?? 'POST',
              path: reqPath,
              audit,
              inputTokens: saved,
              usage: null,
              respModel: respModel ?? hit.meta.model,
              headers: req.headers,
              skim: skimInfo,
              cacheBreakpointInjected: breakpointInjected,
              cacheBreakpointObserved: breakpointObserved,
              cacheBreakpointDeclinedBy: breakpointDeclinedBy,
            }),
          );
          session.appendSession({
            logDir: LOG_DIR,
            reqPath,
            reqJson,
            headers: req.headers,
            responseText: markdown,
          });
          console.log(
            `[agent-proxy] SKIM HIT ${cacheKey.slice(0, 8)} · saved ~${saved.toLocaleString()} input tok · logs/${base}.md`,
          );
        } catch (err) {
          console.error(`[agent-proxy] skim hit served, logging failed: ${errorMessage(err)}`);
        }
        return;
      }
    }

    // ---- Miss: normal transparent pass-through to Anthropic ----
    const upstream = https.request(
      {
        hostname: UPSTREAM,
        port: 443,
        path: reqPath,
        method: req.method,
        headers: forwardHeaders(req.headers, forwardBody),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const respChunks: Buffer[] = [];
        up.on('data', (c: Buffer) => {
          respChunks.push(c);
          res.write(c);
        });
        up.on('end', () => {
          res.end();
          if (isTokenCount(reqPath)) return;

          // ---- The keep-alive capture ----
          // Only for a session that registered, and only on a forward upstream actually
          // accepted: a ping replays the stored body verbatim, so storing one upstream
          // rejected would schedule a request already known to fail. `noteWarmRequest`
          // answers false for every session nobody registered, storing nothing and
          // costing one map lookup — which is what keeps this off the hot path.
          //
          // Deliberately not on the skim-hit path above: a skim hit is served from this
          // proxy's own cache and never reaches Anthropic, so it refreshes no upstream
          // prefix. Treating it as activity would push the ping back while the cache it
          // exists to hold open carried on expiring.
          const upstreamStatus = up.statusCode ?? 0;
          if (
            upstreamStatus >= 200 &&
            upstreamStatus < 300 &&
            noteWarmRequest({ sessionKey, account: sender.account, reqJson, headers: req.headers, startedAt })
          ) {
            writeWarmStatus(LOG_DIR);
          }

          // Past the keep-alive on purpose: a bodyless request is one this proxy writes
          // no capture triple for, but it is still a forwarded request upstream saw, so
          // the registry above judges it on its own terms.
          if (!isCapturable(reqPath, body)) return;

          try {
            const rawResponse = Buffer.concat(respChunks);
            const { markdown, inputTokens, usage, model: respModel } = decodeResponse(rawResponse.toString('utf8'));
            const audit = auditRequest(reqJson ?? {}, inputTokens);
            const statusCode = up.statusCode ?? 0;

            // A read past this request's own system+tools prefix is the only proof
            // that the *message* prefix is cached upstream — the evidence gate 5 of
            // `ensureMessageBreakpoint` needs before a write can pay for itself.
            // `estPrefixTokens`, not the display `estTokens`: the threshold takes a
            // floor of the same corpus where the display estimate takes its median,
            // so this rounds toward declining. The `bytes / 4` both once shared
            // marked sessions warm off a read of nothing but their own system blocks.
            noteCacheRead(
              sessionKey,
              usage?.cache_read_input_tokens ?? 0,
              estPrefixTokens(audit.systemBytes + audit.toolsBytes),
            );

            // Store a successful streamed reply so a byte-exact repeat hits.
            if (canSkim && cacheKey && statusCode === 200) {
              skim.store(skimDir, cacheKey, {
                statusCode,
                contentType: up.headers['content-type'],
                rawResponse,
                inputTokens,
                model: asText(reqJson?.model) ?? undefined,
              });
            }
            const skimInfo: SkimInfo = {
              enabled: skim.skimEnabled(),
              servedFromCache: false,
              savedInputTokens: 0,
              cacheKey,
            };

            fs.mkdirSync(LOG_DIR, { recursive: true });
            recordPrompt(LOG_DIR, audit.systemPrompt);
            fs.writeFileSync(path.join(LOG_DIR, `${base}.request.txt`), forwardBody.toString('utf8'));
            fs.writeFileSync(
              path.join(LOG_DIR, `${base}.md`),
              renderMarkdown(
                {
                  reqJson,
                  timestamp,
                  method: req.method ?? 'POST',
                  path: reqPath,
                  statusCode,
                  headers: req.headers,
                },
                audit,
                markdown,
              ),
            );
            fs.writeFileSync(
              path.join(LOG_DIR, `${base}.audit.json`),
              writeAuditSidecar({
                timestamp,
                reqJson,
                statusCode,
                method: req.method ?? 'POST',
                path: reqPath,
                audit,
                inputTokens,
                usage,
                respModel,
                headers: req.headers,
                respHeaders: up.headers,
                skim: skimInfo,
                cacheBreakpointInjected: breakpointInjected,
                cacheBreakpointObserved: breakpointObserved,
                cacheBreakpointDeclinedBy: breakpointDeclinedBy,
              }),
            );
            session.appendSession({
              logDir: LOG_DIR,
              reqPath,
              reqJson,
              headers: req.headers,
              responseText: markdown,
            });
            printAudit(audit, base);
          } catch (err) {
            console.error(`[agent-proxy] could not render (non-JSON body?): ${errorMessage(err)}`);
          }
        });
      },
    );
    upstream.on('error', (err) => {
      console.error(`[agent-proxy] upstream error: ${errorMessage(err)}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `agent-proxy upstream error: ${errorMessage(err)}` }));
    });
    if (forwardBody.length > 0) upstream.write(forwardBody);
    upstream.end();
  });
}

// Start the server only when run directly, not when imported by a test.
const entry = process.argv[1];
const isMain = entry && path.resolve(entry) === fileURLToPath(import.meta.url);
if (isMain) {
  http.createServer(handle).listen(PORT, HOST || undefined, () => {
    console.log(`[agent-proxy] listening on http://${HOST || '0.0.0.0'}:${PORT}`);
    console.log(`[agent-proxy] point Claude Code at it:  ANTHROPIC_BASE_URL=http://localhost:${PORT} claude`);
  });
  // Nothing to ask for until a request has gone through and handed us a token,
  // so the first tick is a minute out rather than immediate.
  startUsagePolling(LOG_DIR);

  // The keep-alive registry. Its bearer is scoped to one account with no cross-account
  // fallback (ADR 0076); its budget is read off Anthropic's own meter in
  // `usage-live.json` rather than the local sidecar corpus, which by design does not
  // record a ping at all (ADR 0077 §2). One sweeper for the whole registry and one
  // status mirror, both unref'd — neither holds the process open.
  setBearerSource(bearerForAccount);
  setUtilizationSource(usageLiveUtilization(LOG_DIR));
  startKeepalive();
  startWarmStatusMirror(LOG_DIR);
}

// Exported for unit tests.
export {
  auditRequest,
  decodeResponse,
  extractSession,
  INJECTED_REMINDERS,
  stripInjectedReminders,
  stripWithheldTools,
  sumInputTokens,
  WITHHELD_TOOLS,
  writeAuditSidecar,
};
