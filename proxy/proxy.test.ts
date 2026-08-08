/**
 * Unit tests for the audit-logging fixes: non-streaming usage capture and
 * per-session/agent identity. Zero-dependency — Node's built-in test runner,
 * which strips the types itself.
 *
 * Run:  node --test proxy/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditRequest,
  decodeResponse,
  extractSession,
  INJECTED_REMINDERS,
  stripInjectedReminders,
  stripWithheldTools,
  sumInputTokens,
  WITHHELD_TOOLS,
  writeAuditSidecar,
} from './proxy.ts';
import {
  _resetThreads,
  appendSession,
  argsHashFor,
  chatMarkersDir,
  countNodeLines,
  distillMessage,
  distillMessages,
  extractTitle,
  firstUserText,
  isTitleRequest,
  rootPrompt,
  sessionsDir,
  threadIdFor,
} from './session.ts';
import type { RequestBody, ToolDefinition, WireMessage } from './wire.ts';

/** The strip helpers hand back a `RequestBody`; these read the parts a test asserts on. */
const toolsOf = (body: RequestBody | null): ToolDefinition[] => (body?.tools as ToolDefinition[] | undefined) ?? [];
const messagesOf = (body: RequestBody | null): WireMessage[] => (body?.messages as WireMessage[] | undefined) ?? [];

// Non-streaming response body: a single JSON message object with usage at the top level, no SSE frames.
const nonStreamingBody = JSON.stringify({
  model: 'claude-sonnet-5',
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: '<severity>5' }],
  stop_reason: 'stop_sequence',
  usage: {
    input_tokens: 90,
    cache_creation_input_tokens: 38845,
    cache_read_input_tokens: 0,
    output_tokens: 9,
  },
});

// A minimal streamed (SSE) response.
const streamingBody = [
  `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } })}`,
  `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}`,
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { text: 'hello' } })}`,
  `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } })}`,
  'data: [DONE]',
].join('\n\n');

test('non-streaming response: usage is parsed instead of logged as zero', () => {
  const { usage, inputTokens, model } = decodeResponse(nonStreamingBody);
  assert.notEqual(usage, null, 'usage should be extracted from top-level JSON');
  assert.equal(usage?.input_tokens, 90);
  assert.equal(usage?.output_tokens, 9);
  assert.equal(usage?.cache_creation_input_tokens, 38845);
  // realInput = input + cacheRead + cacheCreation = 90 + 0 + 38845
  assert.equal(inputTokens, 38935);
  assert.equal(model, 'claude-sonnet-5');
});

test('non-streaming response: markdown includes the assistant text', () => {
  const { markdown } = decodeResponse(nonStreamingBody);
  assert.match(markdown, /severity/);
  assert.match(markdown, /stop reason/);
});

test('streaming response still decodes usage and model', () => {
  const { usage, inputTokens, model } = decodeResponse(streamingBody);
  assert.equal(model, 'claude-opus-4-8');
  assert.equal(usage?.output_tokens, 42);
  assert.equal(inputTokens, 2 + 100 + 10);
});

test('garbage body degrades gracefully (no usage, no throw)', () => {
  const { usage, inputTokens } = decodeResponse('not json, not sse');
  assert.equal(usage, null);
  assert.equal(inputTokens, null);
});

test('sumInputTokens returns null for missing usage', () => {
  assert.equal(sumInputTokens(null), null);
  assert.equal(sumInputTokens({ input_tokens: 5 }), 5);
});

test('extractSession reads Claude Code headers and metadata.user_id', () => {
  const headers = {
    'x-claude-code-session-id': '8e94a38f-1613',
    'x-app': 'cli-bg',
    'user-agent': 'claude-cli/2.1.215 (external, cli)',
  };
  const reqJson = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'dev123',
        account_uuid: 'acct456',
        session_id: 'meta789',
      }),
    },
  };
  const s = extractSession(headers, reqJson);
  assert.equal(s.sessionId, '8e94a38f-1613');
  assert.equal(s.app, 'cli-bg');
  assert.equal(s.userAgent, 'claude-cli/2.1.215 (external, cli)');
  assert.equal(s.account, 'acct456');
  assert.equal(s.metadataSessionId, 'meta789');
  assert.equal(s.deviceId, 'dev123');
});

test('extractSession tolerates missing headers and non-JSON user_id', () => {
  const s = extractSession(undefined, { metadata: { user_id: 'not-json' } });
  assert.equal(s.sessionId, null);
  assert.equal(s.account, null);
  assert.equal(s.metadataSessionId, null);
});

test('stripWithheldTools removes EndConversation from the tools array', () => {
  const reqJson = {
    model: 'claude-opus-4-8',
    tools: [{ name: 'Read' }, { name: 'EndConversation' }, { name: 'Bash' }],
  };
  const { reqJson: out, removed } = stripWithheldTools(reqJson);
  assert.deepEqual(removed, ['EndConversation']);
  assert.deepEqual(
    toolsOf(out).map((t) => t.name),
    ['Read', 'Bash'],
  );
  // Source object is left untouched (shallow copy on strip).
  assert.equal(reqJson.tools.length, 3);
  assert.equal(WITHHELD_TOOLS.has('EndConversation'), true);
});

test('stripWithheldTools is a no-op (same reference) when nothing to strip', () => {
  const noTools = { model: 'claude-opus-4-8', messages: [] };
  assert.equal(stripWithheldTools(noTools).reqJson, noTools);
  assert.deepEqual(stripWithheldTools(noTools).removed, []);

  const cleanTools = { tools: [{ name: 'Read' }, { name: 'Bash' }] };
  const res = stripWithheldTools(cleanTools);
  assert.equal(res.reqJson, cleanTools); // untouched → forwarded byte-for-byte
  assert.deepEqual(res.removed, []);

  // Non-array tools and missing body degrade without throwing.
  assert.equal(stripWithheldTools(null).reqJson, null);
  assert.deepEqual(stripWithheldTools({ tools: 'nope' }).removed, []);
});

// The task-tools nudge as the CLI injects it: a standalone message whose whole
// content is the reminder (seen as both a bare string and a single text block).
const TASK_REMINDER =
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.";

test('stripInjectedReminders drops a message whose string content is only the reminder', () => {
  const reqJson = {
    messages: [
      { role: 'user', content: 'real question' },
      { role: 'system', content: `${TASK_REMINDER}\n` },
    ],
  };
  const { reqJson: out, removed } = stripInjectedReminders(reqJson);
  assert.deepEqual(removed, ['task-tools']);
  assert.deepEqual(messagesOf(out), [{ role: 'user', content: 'real question' }]);
  assert.equal(reqJson.messages.length, 2); // source untouched
});

test('stripInjectedReminders drops a text block but keeps the rest of the message', () => {
  const reqJson = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'keep me' },
          { type: 'text', text: TASK_REMINDER },
        ],
      },
    ],
  };
  const { reqJson: out, removed } = stripInjectedReminders(reqJson);
  assert.deepEqual(removed, ['task-tools']);
  assert.deepEqual(messagesOf(out)[0]?.content, [{ type: 'text', text: 'keep me' }]);
});

test('stripInjectedReminders keeps surrounding text when the reminder is embedded', () => {
  const reqJson = {
    messages: [{ role: 'user', content: `before\n\n${TASK_REMINDER}\n\nafter` }],
  };
  const { reqJson: out, removed } = stripInjectedReminders(reqJson);
  assert.deepEqual(removed, ['task-tools']);
  assert.equal(messagesOf(out)[0]?.content, 'before\n\nafter');
});

test('stripInjectedReminders tolerates wording drift in the middle of the nudge', () => {
  const drifted = "The task tools haven't been used recently. Some new middle wording here. ignore if not applicable.";
  const { removed } = stripInjectedReminders({ messages: [{ role: 'system', content: drifted }] });
  assert.deepEqual(removed, ['task-tools']);
});

test('stripInjectedReminders is a no-op (same reference) when nothing matches', () => {
  const clean = { messages: [{ role: 'user', content: 'hello' }] };
  const res = stripInjectedReminders(clean);
  assert.equal(res.reqJson, clean); // untouched → forwarded byte-for-byte
  assert.deepEqual(res.removed, []);

  // Missing / non-array messages degrade without throwing.
  assert.equal(stripInjectedReminders(null).reqJson, null);
  assert.deepEqual(stripInjectedReminders({ messages: 'nope' }).removed, []);
  assert.equal(INJECTED_REMINDERS[0]?.id, 'task-tools');
});

test('sidecar carries real tokens, session, and model for a non-streaming call', () => {
  const { usage, inputTokens, model } = decodeResponse(nonStreamingBody);
  const reqJson = { metadata: { user_id: JSON.stringify({ account_uuid: 'acct456', session_id: 'meta789' }) } };
  const audit = auditRequest(reqJson, inputTokens);
  const json = writeAuditSidecar({
    timestamp: '2026-07-20T01:15:22.069Z',
    reqJson,
    statusCode: 200,
    method: 'POST',
    path: '/v1/messages?beta=true',
    audit,
    inputTokens,
    usage,
    respModel: model,
    headers: { 'x-claude-code-session-id': 'sess-1', 'x-app': 'cli-bg' },
    skim: null,
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.model, 'claude-sonnet-5'); // reqJson had no model → response model fallback
  assert.equal(parsed.tokens.output, 9);
  assert.equal(parsed.tokens.cacheCreation, 38845);
  assert.equal(parsed.tokens.realInput, 38935);
  assert.equal(parsed.session.sessionId, 'sess-1');
  assert.equal(parsed.session.app, 'cli-bg');
  assert.equal(parsed.session.account, 'acct456');
});

/** A sidecar built from the given upstream response headers. */
function sidecarWithRespHeaders(respHeaders: Record<string, string | string[]> | undefined) {
  const { usage, inputTokens, model } = decodeResponse(nonStreamingBody);
  const reqJson = {};
  return JSON.parse(
    writeAuditSidecar({
      timestamp: '2026-07-20T01:15:22.069Z',
      reqJson,
      statusCode: 200,
      method: 'POST',
      path: '/v1/messages',
      audit: auditRequest(reqJson, inputTokens),
      inputTokens,
      usage,
      respModel: model,
      headers: {},
      respHeaders,
      skim: null,
    }),
  );
}

test('sidecar records only rate-limit response headers, so no auth rides along', () => {
  const parsed = sidecarWithRespHeaders({
    'Anthropic-RateLimit-Unified-5h-Utilization': '0.42',
    'x-ratelimit-limit': '100',
    'anthropic-organization-id': 'org-1',
    authorization: 'Bearer sk-secret',
    'set-cookie': ['a=1', 'b=2'],
    'content-type': 'application/json',
  });
  assert.deepEqual(parsed.rateLimit, {
    'anthropic-ratelimit-unified-5h-utilization': '0.42', // name lowercased, value verbatim
    'x-ratelimit-limit': '100',
  });
});

test('sidecar joins repeated rate-limit header values', () => {
  const parsed = sidecarWithRespHeaders({ 'anthropic-ratelimit-unified-5h-reset': ['60', '90'] });
  assert.equal(parsed.rateLimit['anthropic-ratelimit-unified-5h-reset'], '60, 90');
});

test('sidecar omits rateLimit when upstream sent none', () => {
  assert.equal('rateLimit' in sidecarWithRespHeaders({ 'content-type': 'application/json' }), false);
  // The skim-cache path serves without an upstream call, so it passes no headers.
  assert.equal('rateLimit' in sidecarWithRespHeaders(undefined), false);
});

// ---------------------------------------------------------------------------
// Session transcripts (session.ts)
// ---------------------------------------------------------------------------

const userText = (t: string): WireMessage => ({ role: 'user', content: [{ type: 'text', text: t }] });

test('threadIdFor: stable per root, namespaced by session, null when no root', () => {
  const msgs = [userText('Fix the login bug')];
  const a = threadIdFor('sess-1', msgs);
  assert.equal(a, threadIdFor('sess-1', msgs)); // stable
  assert.notEqual(a, threadIdFor('sess-2', msgs)); // session-namespaced
  assert.notEqual(a, threadIdFor('sess-1', [userText('Different task')]));
  assert.equal(threadIdFor('sess-1', []), null);
  // Pinned digest: thread ids name files on disk and are stored in `.state.json`,
  // so changing this formula orphans every transcript already written.
  assert.equal(a, 'ebd92420bd68e6f7');
  // A tool-result-only user turn is not a root — first *text* wins.
  assert.equal(
    firstUserText([{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, userText('real root')]),
    'real root',
  );
});

test('distillMessage: task / decided+tool / error / done mapping', () => {
  assert.deepEqual(distillMessage(userText('Add a feature')), ['\n## Task: Add a feature']);

  // Injected <system-reminder> context is stripped from the task line.
  assert.deepEqual(distillMessage(userText('<system-reminder>\nctx blob\n</system-reminder>\n\nAdd a feature')), [
    '\n## Task: Add a feature',
  ]);

  const assistantWithTool = {
    role: 'assistant',
    content: [
      { type: 'text', text: "I'll edit the file to fix it." },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' } },
    ],
  };
  assert.deepEqual(distillMessage(assistantWithTool), [
    "- decided: I'll edit the file to fix it.",
    '- ▸ Edit(file_path=/a/b.ts)',
  ]);

  // Only the first call of a message is marked — the rest went out with it, in one turn.
  const batched = {
    role: 'assistant',
    content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/b.ts' } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
    ],
  };
  assert.deepEqual(distillMessage(batched), [
    '- ▸ Read(file_path=/a.ts)',
    '- Read(file_path=/b.ts)',
    '- Grep(pattern=foo)',
  ]);

  const errored = { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] };
  assert.deepEqual(distillMessage(errored), ['- ✗ ENOENT: no such file']);

  const plainAnswer = { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] };
  assert.deepEqual(distillMessage(plainAnswer), ['- done: All tests pass.']);

  // Schemas/full inputs never leak: only the allowlisted key arg is kept.
  const bash = {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la', timeout: 5000 } }],
  };
  assert.deepEqual(distillMessage(bash), ['- ▸ Bash(command=ls -la)']);

  // thinking blocks are dropped.
  assert.deepEqual(distillMessages([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }]), []);
});

test('appendSession: one-shot helper calls never get a file; real threads grow append-only', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-A' };

  // A one-shot helper call: seen exactly once, small, never grows.
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-sonnet-5', messages: [userText('classify this')] },
    headers,
  });
  assert.equal(fs.existsSync(dir), false, 'first sighting is buffered, not written');

  // A real agent thread: first request (buffered), then a grown follow-up (flushed).
  const m1 = [userText('Build the parser')];
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: m1 },
    headers,
  });
  const tid = threadIdFor('sess-A', m1);
  const md = path.join(dir, `${tid}.md`);
  assert.equal(fs.existsSync(md), false, 'still buffered after one sighting');

  const m2 = [
    ...m1,
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the grammar first.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/g.ebnf' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'parse error at line 3' }] },
  ];
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: m2 },
    headers,
  });

  const out = fs.readFileSync(md, 'utf8');
  assert.match(out, /# Session/);
  assert.match(out, /## Task: Build the parser/);
  assert.match(out, /- decided: Reading the grammar first\./);
  assert.match(out, /- ▸ Read\(file_path=\/g\.ebnf\)/);
  assert.match(out, /- ✗ parse error at line 3/);

  // A state sidecar records progress for restart recovery.
  const state = JSON.parse(fs.readFileSync(path.join(dir, `${tid}.state.json`), 'utf8'));
  assert.equal(state.count, m2.length);
  assert.equal(state.started, true);

  // Append-only: a duplicate/no-growth request adds nothing.
  const before = fs.readFileSync(md, 'utf8');
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: m2 },
    headers,
  });
  assert.equal(fs.readFileSync(md, 'utf8'), before);

  // Restart recovery: forget in-memory state, replay m2 — the sidecar prevents re-appending.
  _resetThreads();
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: m2 },
    headers,
  });
  assert.equal(fs.readFileSync(md, 'utf8'), before, 'state sidecar dedupes across a restart');

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: an interactive chat is confirmed on sight, no growth needed', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-chat-'));
  const dir = sessionsDir(logDir);
  // What the dashboard's chat sends: its own session id plus the interactive marker.
  const headers = { 'x-claude-code-session-id': 'sess-chat', 'x-claude-proxy-chat': '1' };

  const m1 = [userText('Draft the release note')];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-5', messages: m1 }, headers });

  const tid = threadIdFor('sess-chat', m1);
  const md = path.join(dir, `${tid}.md`);
  const out = fs.readFileSync(md, 'utf8');
  assert.match(out, /# Session/, 'first turn already on disk — no second sighting required');
  assert.match(out, /## Task: Draft the release note/);
  assert.match(out, /- subtitle: Draft the release note/);

  // Still append-only from there: a grown follow-up adds only its new turns.
  const m2 = [...m1, { role: 'assistant', content: [{ type: 'text', text: 'Here is the note.' }] }];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-5', messages: m2 }, headers });
  const grown = fs.readFileSync(md, 'utf8');
  assert.equal(grown.indexOf('# Session'), grown.lastIndexOf('# Session'), 'header written once');
  assert.match(grown, /- done: Here is the note\./);

  // The marker is the only difference: without it, a first sighting still buffers.
  _resetThreads();
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-sonnet-5', messages: [userText('classify this')] },
    headers: { 'x-claude-code-session-id': 'sess-chat' },
  });
  assert.equal(fs.existsSync(path.join(dir, `${threadIdFor('sess-chat', [userText('classify this')])}.md`)), false);

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: a marker file exempts a chat that cannot send the header', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-marker-'));
  // What the dashboard writes before spawning a headless CLI turn: the CLI builds
  // its own headers, so the session id is declared on disk instead.
  fs.mkdirSync(chatMarkersDir(logDir), { recursive: true });
  fs.writeFileSync(
    path.join(chatMarkersDir(logDir), 'sess-headless.json'),
    JSON.stringify({ declaredAt: '2026-07-25T00:00:00.000Z' }),
  );

  const headers = { 'x-claude-code-session-id': 'sess-headless' };
  const m1 = [userText('Explain the skim cache')];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-5', messages: m1 }, headers });

  const md = path.join(sessionsDir(logDir), `${threadIdFor('sess-headless', m1)}.md`);
  assert.match(fs.readFileSync(md, 'utf8'), /## Task: Explain the skim cache/, 'declared chat is confirmed on sight');

  // An undeclared session id under the same store still buffers.
  _resetThreads();
  const other = [userText('summarize this diff')];
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-5', messages: other },
    headers: { 'x-claude-code-session-id': 'sess-plain' },
  });
  assert.equal(fs.existsSync(path.join(sessionsDir(logDir), `${threadIdFor('sess-plain', other)}.md`)), false);

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('rootPrompt: strips the <system-reminder> context, keeps the real first prompt', () => {
  const messages = [userText('<system-reminder>\ncontext blob\n</system-reminder>\n\nFix the login bug')];
  assert.equal(rootPrompt(messages), 'Fix the login bug');
  // No reminder — the prompt passes through, whitespace-collapsed.
  assert.equal(rootPrompt([userText('  just   this  ')]), 'just this');
});

test('isTitleRequest / extractTitle: detect the CLI titling request and its reply', () => {
  const titleReq = {
    system: [
      { type: 'text', text: 'You are a Claude agent.' },
      { type: 'text', text: 'Generate a concise, sentence-case title (3-7 words) …' },
    ],
    messages: [userText('<session>\nsay the single word: mike\n</session>\n\nWrite the title …')],
  };
  assert.equal(isTitleRequest(titleReq), true);
  assert.equal(isTitleRequest({ system: 'You are a normal agent.', messages: [] }), false);

  assert.equal(
    extractTitle('<assistant-text>\n\n{"title": "Say the word mike"}\n\n</assistant-text>'),
    'Say the word mike',
  );
  assert.equal(extractTitle('{"title": "Escaped \\"quote\\" here"}'), 'Escaped "quote" here');
  assert.equal(extractTitle('no title here'), null);
  assert.equal(extractTitle(undefined), null);
});

test('appendSession: writes a subtitle and links an out-of-band title to its thread', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-title-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-T' };

  const first = userText('<system-reminder>\nctx\n</system-reminder>\n\nsay the single word: mike');
  const m1 = [first];
  const m2 = [first, { role: 'assistant', content: [{ type: 'text', text: 'mike' }] }];

  // First sighting buffers; the follow-up confirms and flushes.
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m1 }, headers });
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });

  const tid = threadIdFor('sess-T', m1);
  const md = path.join(dir, `${tid}.md`);
  let out = fs.readFileSync(md, 'utf8');
  // Subtitle is the reminder-free first prompt; no title yet.
  assert.match(out, /- subtitle: say the single word: mike/);
  assert.doesNotMatch(out, /- title:/);

  // The titling request (its own session id, content wrapped in <session>) lands
  // later; its reply is linked to this thread by content.
  const titleReq = {
    system: [{ type: 'text', text: 'Generate a concise, sentence-case title (3-7 words).' }],
    messages: [userText('<session>\nsay the single word: mike\n</session>\n\nWrite the title …')],
  };
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: titleReq,
    headers: { 'x-claude-code-session-id': 'sess-title-gen' },
    responseText: '<assistant-text>\n\n{"title": "Say the word mike"}\n\n</assistant-text>',
  });

  out = fs.readFileSync(md, 'utf8');
  assert.match(out, /- title: Say the word mike/, 'title appended to the confirmed thread');
  // The titling request itself never becomes a transcript of its own.
  assert.equal(fs.existsSync(path.join(dir, `${threadIdFor('sess-title-gen', titleReq.messages)}.md`)), false);

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: a title seen before its thread rides into the header at confirmation', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-title2-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-E' };

  // Title arrives first — no thread yet, so it's stashed.
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: {
      system: [{ type: 'text', text: 'Generate a concise, sentence-case title.' }],
      messages: [userText('<session>\nrun the report\n</session>')],
    },
    headers: { 'x-claude-code-session-id': 'gen' },
    responseText: '{"title": "Run the report"}',
  });

  const first = userText('run the report');
  const m1 = [first];
  const m2 = [first, { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m1 }, headers });
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });

  const md = path.join(dir, `${threadIdFor('sess-E', m1)}.md`);
  const out = fs.readFileSync(md, 'utf8');
  // The title is in the header block (before the first task), not appended after.
  assert.match(out, /- title: Run the report\n- subtitle: run the report/);
  assert.equal((out.match(/- title:/g) || []).length, 1, 'title written exactly once');
});

test('appendSession: back-fills a missing subtitle when root is learned after the header was flushed', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-latesub-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-M' };

  const first = userText('<system-reminder>\nctx\n</system-reminder>\n\nharden the subtitle path');
  const m2 = [first, { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }];
  const tid = threadIdFor('sess-M', [first]);

  // A thread confirmed by an older proxy: header without a subtitle, sidecar predating `root`.
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, `${tid}.md`);
  fs.writeFileSync(
    md,
    `\n# Session ${tid}\n- model: claude-opus-4-8\n- session: sess-M\n- started: 2026-01-01T00:00:00.000Z\n\n`,
  );
  fs.writeFileSync(path.join(dir, `${tid}.state.json`), JSON.stringify({ count: 1, started: true }));

  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });

  let out = fs.readFileSync(md, 'utf8');
  assert.match(out, /- subtitle: harden the subtitle path/, 'missing subtitle back-filled');
  assert.equal((out.match(/- subtitle:/g) || []).length, 1, 'subtitle written exactly once');

  // Idempotent across a restart.
  _resetThreads();
  const m4 = [...m2, userText('continue'), { role: 'assistant', content: [{ type: 'text', text: 'done' }] }];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m4 }, headers });
  out = fs.readFileSync(md, 'utf8');
  assert.equal((out.match(/- subtitle:/g) || []).length, 1, 'subtitle not duplicated on later turns');

  fs.rmSync(logDir, { recursive: true, force: true });
});

/** Confirm a thread (first sighting buffers, the second flushes) and return its id. */
function confirmThread(logDir: string, sessionId: string, prompt: string): string | null {
  const headers = { 'x-claude-code-session-id': sessionId };
  const first = userText(prompt);
  const m1 = [first];
  const m2 = [first, { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m1 }, headers });
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });
  return threadIdFor(sessionId, m1);
}

/** Feed one titling request through, as the CLI's out-of-band namer would. */
function sendTitle(logDir: string, prompt: string, title: string): void {
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: {
      system: [{ type: 'text', text: 'Generate a concise, sentence-case title (3-7 words).' }],
      messages: [userText(`<session>\n${prompt}\n</session>`)],
    },
    headers: { 'x-claude-code-session-id': 'gen' },
    responseText: `{"title": "${title}"}`,
  });
}

test('appendSession: two threads sharing an opening prompt each keep their own title', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-dup-'));
  const dir = sessionsDir(logDir);
  const prompt = 'run the probe twice';

  // The same prompt run in two CLI sessions — same root, different thread ids.
  const older = confirmThread(logDir, 'sess-A', prompt);
  const newer = confirmThread(logDir, 'sess-B', prompt);
  assert.notEqual(older, newer);

  sendTitle(logDir, prompt, 'Run the probe');
  sendTitle(logDir, prompt, 'Run the probe again');

  const readTitles = (tid: string | null) =>
    fs.readFileSync(path.join(dir, `${tid}.md`), 'utf8').match(/- title: (.*)/g) ?? [];
  // Newest untitled thread is named first; the second title falls to the other one.
  assert.deepEqual(readTitles(newer), ['- title: Run the probe']);
  assert.deepEqual(readTitles(older), ['- title: Run the probe again']);

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: titles a thread that only exists on disk after a restart', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-restart-'));
  const dir = sessionsDir(logDir);
  const prompt = 'survive the restart';

  const tid = confirmThread(logDir, 'sess-R', prompt);
  _resetThreads(); // the proxy restarts: the transcript is on disk, nothing is in memory

  sendTitle(logDir, prompt, 'Survive the restart');

  const out = fs.readFileSync(path.join(dir, `${tid}.md`), 'utf8');
  assert.match(out, /- title: Survive the restart/, 'title reached the on-disk thread');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${tid}.state.json`), 'utf8')).titled, true);

  // …and a later turn on that thread doesn't append it a second time.
  const first = userText(prompt);
  const m3 = [
    first,
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    userText('more'),
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: m3 },
    headers: { 'x-claude-code-session-id': 'sess-R' },
  });
  const after = fs.readFileSync(path.join(dir, `${tid}.md`), 'utf8');
  assert.equal((after.match(/- title:/g) || []).length, 1, 'title written exactly once');

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: an unclaimed title survives a restart in its sidecar', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-pending-'));
  const dir = sessionsDir(logDir);
  const prompt = 'claim me later';

  // Titled before the thread was ever seen — nothing on disk or in memory to attach to.
  sendTitle(logDir, prompt, 'Claim me later');
  assert.equal(fs.existsSync(path.join(dir, '.pending-titles.json')), true, 'deferred to the sidecar');

  _resetThreads(); // the proxy restarts before the thread arrives

  const tid = confirmThread(logDir, 'sess-P', prompt);
  const out = fs.readFileSync(path.join(dir, `${tid}.md`), 'utf8');
  assert.match(out, /- title: Claim me later\n- subtitle: claim me later/, 'claimed into the header');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, '.pending-titles.json'), 'utf8')),
    [],
    'and cleared once claimed',
  );

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: records the whole text behind each truncated line, keyed by node index', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-full-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-F' };

  const task = Array.from({ length: 80 }, () => 'task').join(' ');
  const command = Array.from({ length: 40 }, () => 'echo').join(' ');
  const m1 = [userText(task)];
  const m2 = [
    ...m1,
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Short reason.' },
        { type: 'tool_use', name: 'Bash', input: { command } },
      ],
    },
  ];

  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m1 }, headers });
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });

  const tid = threadIdFor('sess-F', m1);
  const md = path.join(dir, `${tid}.md`);
  const rows = fs
    .readFileSync(path.join(dir, `${tid}.nodes.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

  // Node 0 is the task and node 2 the tool call; node 1's `- decided:` said it all.
  assert.deepEqual(
    rows.map((r) => r.i),
    [0, 2],
  );
  assert.equal(rows[0].text, task);
  assert.equal(rows[1].text, `Bash(command=${command})`);
  assert.equal(
    countNodeLines(fs.readFileSync(md, 'utf8')),
    3,
    'sidecar indices count the same nodes the transcript holds',
  );

  // The transcript itself keeps its one-line gists — the whole text stays out of it.
  const out = fs.readFileSync(md, 'utf8');
  assert.match(out, /## Task: task task .*…$/m);
  assert.equal(out.includes(command), false);

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: a transcript that predates the sidecar keeps its indices aligned', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-pre-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-P' };

  const m1 = [userText('Build the parser')];
  const tid = threadIdFor('sess-P', m1);
  const md = path.join(dir, `${tid}.md`);

  // An older proxy's leavings: a transcript with three nodes and state carrying no count.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    md,
    [
      '',
      `# Session ${tid}`,
      '- model: claude-opus-4-8',
      '',
      '## Task: Build the parser',
      '- decided: Reading first.',
      '- Read(file_path=/g.ebnf)',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, `${tid}.state.json`),
    JSON.stringify({ count: 1, started: true, root: 'Build the parser', title: null, titled: false, subtitled: true }),
  );

  const command = Array.from({ length: 40 }, () => 'echo').join(' ');
  const m2 = [...m1, { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] }];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });

  const rows = fs
    .readFileSync(path.join(dir, `${tid}.nodes.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  // The new node is the transcript's fourth — not its first.
  assert.deepEqual(
    rows.map((r) => r.i),
    [3],
  );
  assert.equal(countNodeLines(fs.readFileSync(md, 'utf8')), 4);

  fs.rmSync(logDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Join keys written at capture time
// ---------------------------------------------------------------------------

test('argsHashFor: fingerprints the whole argument object, not the rendered line', () => {
  const long = `/Users/x/.claude/worktrees/feat-a-very-long-branch-name/${'nested/'.repeat(6)}`;
  // Two calls whose display signature truncates to the same prefix are still distinct.
  assert.notEqual(argsHashFor('Read', { file_path: `${long}a.ts` }), argsHashFor('Read', { file_path: `${long}b.ts` }));
  // Key order is not part of the call.
  assert.equal(argsHashFor('Bash', { command: 'ls', timeout: 5 }), argsHashFor('Bash', { timeout: 5, command: 'ls' }));
  // The tool name is part of it, and the digest is a stable 16 hex chars.
  assert.notEqual(argsHashFor('Read', { file_path: '/a.ts' }), argsHashFor('Grep', { file_path: '/a.ts' }));
  assert.match(argsHashFor('Read', { file_path: '/a.ts' }), /^[0-9a-f]{16}$/);
});

test('extractSession: carries the thread id, and omits it when there is no root to hash', () => {
  const headers = { 'x-claude-code-session-id': 'sess-X' };
  const messages = [userText('Fix the login bug')];
  const withRoot = extractSession(headers, { model: 'claude-opus-5', messages });
  assert.equal(withRoot.threadId, threadIdFor('sess-X', messages));
  // Absent, not null: the sidecar's session block omits what it does not know, and the
  // SQLite source rebuilds it the same way.
  assert.equal('threadId' in extractSession(headers, { model: 'claude-opus-5', messages: [] }), false);
});

test('appendSession: writes an argument fingerprint beside each tool call', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-hash-'));
  const dir = sessionsDir(logDir);
  const headers = { 'x-claude-code-session-id': 'sess-H' };

  const long = `/Users/x/.claude/worktrees/feat-a-very-long-branch-name/${'nested/'.repeat(6)}`;
  const m1 = [userText('Read them both')];
  const m2 = [
    ...m1,
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: `${long}a.ts` } },
        { type: 'tool_use', name: 'Read', input: { file_path: `${long}b.ts` } },
      ],
    },
  ];
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m1 }, headers });
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: m2 }, headers });

  const tid = threadIdFor('sess-H', m1);
  const rows = fs
    .readFileSync(path.join(dir, `${tid}.nodes.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const hashes = rows.filter((r) => r.argsHash);
  assert.deepEqual(
    hashes.map((r) => r.i),
    [1, 2],
  );
  assert.equal(hashes[0].argsHash, argsHashFor('Read', { file_path: `${long}a.ts` }));
  // The two lines render alike once truncated; the fingerprints keep them apart.
  assert.notEqual(hashes[0].argsHash, hashes[1].argsHash);
  // The task node is text-only — a node that is not a call gets no fingerprint.
  assert.equal(rows.find((r) => r.i === 0)?.argsHash, undefined);

  fs.rmSync(logDir, { recursive: true, force: true });
});

/** One assistant turn that spawns `prompt` under `agentType`, appended to `messages`. */
const spawnTurn = (messages: WireMessage[], prompt: string, agentType: string): WireMessage[] => [
  ...messages,
  {
    role: 'assistant',
    content: [{ type: 'tool_use', name: 'Agent', input: { prompt, subagent_type: agentType } }],
  },
];

test('appendSession: records the spawning thread on a child already on disk', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-spawn-'));
  const dir = sessionsDir(logDir);

  // The child runs and is confirmed first: a blocking spawn's `tool_use` block only
  // reaches the wire in the parent's *next* request, after the child finished.
  const childPrompt = 'search for the handler';
  const child = confirmThread(logDir, 'sess-S', childPrompt);

  const parentHeaders = { 'x-claude-code-session-id': 'sess-S' };
  const p1 = [userText('Fix the login bug')];
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: p1 },
    headers: parentHeaders,
  });
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: spawnTurn(p1, childPrompt, 'Explore') },
    headers: parentHeaders,
  });

  const parent = threadIdFor('sess-S', p1);
  const out = fs.readFileSync(path.join(dir, `${child}.md`), 'utf8');
  assert.match(out, new RegExp(`- parent: ${parent}`), 'child names the thread that spawned it');
  assert.match(out, /- spawn: 1/, 'and the node index of the spawning call');
  assert.match(out, /- agent: Explore/);
  // Written once, and mirrored into the sidecar so a restart does not repeat it.
  assert.equal((out.match(/- parent:/g) || []).length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, `${child}.state.json`), 'utf8'));
  assert.equal(state.parent, parent);
  assert.equal(state.linked, true);

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: a spawn seen before its child rides into the child’s header', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-spawn2-'));
  const dir = sessionsDir(logDir);
  const parentHeaders = { 'x-claude-code-session-id': 'sess-B' };

  // A backgrounded spawn: the parent's call goes out while the child has yet to speak.
  const childPrompt = 'draft the release note';
  const p1 = [userText('Ship the release')];
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: p1 },
    headers: parentHeaders,
  });
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: spawnTurn(p1, childPrompt, 'general-purpose') },
    headers: parentHeaders,
  });

  const child = confirmThread(logDir, 'sess-B', childPrompt);
  const out = fs.readFileSync(path.join(dir, `${child}.md`), 'utf8');
  assert.match(out, new RegExp(`- parent: ${threadIdFor('sess-B', p1)}`), 'parked record claimed at first sighting');
  assert.match(out, /- agent: general-purpose/);
  // In the header block, before the first task — not appended after it.
  assert.ok(out.indexOf('- parent:') < out.indexOf('## Task:'));

  fs.rmSync(logDir, { recursive: true, force: true });
});

test('appendSession: a thread nothing spawned records no parentage at all', () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-noparent-'));
  const dir = sessionsDir(logDir);

  // A plain run, and a spawn whose prompt matches nothing that ever arrives.
  const tid = confirmThread(logDir, 'sess-N', 'just do the thing');
  const out = fs.readFileSync(path.join(dir, `${tid}.md`), 'utf8');
  assert.equal(out.includes('- parent:'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${tid}.state.json`), 'utf8')).parent, null);

  // A thread never claims itself, even when its own root is the prompt it spawned with.
  const self = [userText('recurse forever')];
  const headers = { 'x-claude-code-session-id': 'sess-N2' };
  appendSession({ logDir, reqPath: '/v1/messages', reqJson: { model: 'claude-opus-4-8', messages: self }, headers });
  appendSession({
    logDir,
    reqPath: '/v1/messages',
    reqJson: { model: 'claude-opus-4-8', messages: spawnTurn(self, 'recurse forever', 'Explore') },
    headers,
  });
  const selfOut = fs.readFileSync(path.join(dir, `${threadIdFor('sess-N2', self)}.md`), 'utf8');
  assert.equal(selfOut.includes('- parent:'), false);

  fs.rmSync(logDir, { recursive: true, force: true });
});
