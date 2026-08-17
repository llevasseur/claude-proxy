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
import { asList, asRecord, asText, type JsonValue, parseJson } from './json.ts';
import * as session from './session.ts';
import * as skim from './skim.ts';
import { identifyPrompt, type PromptIdentity, recordPrompt } from './system-prompt.ts';
import { noteAuth, startUsagePolling } from './usage-live.ts';
import {
  asArrayOf,
  type ContentBlock,
  type HeaderBag,
  type RequestBody,
  type ToolDefinition,
  type Usage,
  type WireMessage,
} from './wire.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1'; // localhost-only by default; set HOST="" to bind all interfaces
const UPSTREAM = 'api.anthropic.com';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Logs live at the repo root (shared with the dashboard server), not next to
// this file. Override with LOG_DIR to point elsewhere.
const LOG_DIR = process.env.LOG_DIR ?? path.join(HERE, '..', 'logs');

/** Rough token estimate for display. Real input tokens come from the response
 * usage; this is only for ranking the request before the reply arrives. */
const estTokens = (bytes: number): number => Math.round(bytes / 4);

/** count_tokens calls send content but get back only a number, never a reply.
 * A single turn fires many as housekeeping — pure noise here, so skip them. */
const isTokenCount = (reqPath: string): boolean => reqPath.includes('count_tokens');

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

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const reqPath = req.url ?? '/';
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const timestamp = new Date().toISOString();
    const base = baseName();

    // Kept in memory for the usage poll; never logged or written to a sidecar.
    noteAuth(req.headers);

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
    const sessionKey = sender.sessionId ?? sender.metadataSessionId;

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
          try {
            const rawResponse = Buffer.concat(respChunks);
            const { markdown, inputTokens, usage, model: respModel } = decodeResponse(rawResponse.toString('utf8'));
            const audit = auditRequest(reqJson ?? {}, inputTokens);
            const statusCode = up.statusCode ?? 0;

            // A read past this request's own system+tools prefix is the only proof
            // that the *message* prefix is cached upstream — the evidence gate 5 of
            // `ensureMessageBreakpoint` needs before a write can pay for itself.
            // `estPrefixTokens`, not the display `estTokens`: `bytes / 4` understates
            // a schema-heavy prefix by ~45%, which marked sessions warm off a read of
            // nothing but their own system blocks.
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
