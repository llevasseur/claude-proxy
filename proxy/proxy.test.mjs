/**
 * Unit tests for the audit-logging fixes: non-streaming usage capture and
 * per-session/agent identity. Zero-dependency — Node's built-in test runner.
 *
 * Run:  node --test proxy/
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeResponse, extractSession, writeAuditSidecar, sumInputTokens, auditRequest, stripWithheldTools, WITHHELD_TOOLS } from "./proxy.mjs";
import { threadIdFor, firstUserText, distillMessage, distillMessages, appendSession, sessionsDir, _resetThreads } from "./session.mjs";

// Non-streaming response body: a single JSON message object with usage at the top level, no SSE frames.
const nonStreamingBody = JSON.stringify({
  model: "claude-sonnet-5",
  id: "msg_test",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "<severity>5" }],
  stop_reason: "stop_sequence",
  usage: {
    input_tokens: 90,
    cache_creation_input_tokens: 38845,
    cache_read_input_tokens: 0,
    output_tokens: 9,
  },
});

// A minimal streamed (SSE) response.
const streamingBody = [
  `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } })}`,
  `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { text: "hello" } })}`,
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } })}`,
  "data: [DONE]",
].join("\n\n");

test("non-streaming response: usage is parsed instead of logged as zero", () => {
  const { usage, inputTokens, model } = decodeResponse(nonStreamingBody);
  assert.ok(usage, "usage should be extracted from top-level JSON");
  assert.equal(usage.input_tokens, 90);
  assert.equal(usage.output_tokens, 9);
  assert.equal(usage.cache_creation_input_tokens, 38845);
  // realInput = input + cacheRead + cacheCreation = 90 + 0 + 38845
  assert.equal(inputTokens, 38935);
  assert.equal(model, "claude-sonnet-5");
});

test("non-streaming response: markdown includes the assistant text", () => {
  const { markdown } = decodeResponse(nonStreamingBody);
  assert.match(markdown, /severity/);
  assert.match(markdown, /stop reason/);
});

test("streaming response still decodes usage and model", () => {
  const { usage, inputTokens, model } = decodeResponse(streamingBody);
  assert.equal(model, "claude-opus-4-8");
  assert.equal(usage.output_tokens, 42);
  assert.equal(inputTokens, 2 + 100 + 10);
});

test("garbage body degrades gracefully (no usage, no throw)", () => {
  const { usage, inputTokens } = decodeResponse("not json, not sse");
  assert.equal(usage, null);
  assert.equal(inputTokens, null);
});

test("sumInputTokens returns null for missing usage", () => {
  assert.equal(sumInputTokens(null), null);
  assert.equal(sumInputTokens({ input_tokens: 5 }), 5);
});

test("extractSession reads Claude Code headers and metadata.user_id", () => {
  const headers = {
    "x-claude-code-session-id": "8e94a38f-1613",
    "x-app": "cli-bg",
    "user-agent": "claude-cli/2.1.215 (external, cli)",
  };
  const reqJson = {
    metadata: {
      user_id: JSON.stringify({
        device_id: "dev123",
        account_uuid: "acct456",
        session_id: "meta789",
      }),
    },
  };
  const s = extractSession(headers, reqJson);
  assert.equal(s.sessionId, "8e94a38f-1613");
  assert.equal(s.app, "cli-bg");
  assert.equal(s.userAgent, "claude-cli/2.1.215 (external, cli)");
  assert.equal(s.account, "acct456");
  assert.equal(s.metadataSessionId, "meta789");
  assert.equal(s.deviceId, "dev123");
});

test("extractSession tolerates missing headers and non-JSON user_id", () => {
  const s = extractSession(undefined, { metadata: { user_id: "not-json" } });
  assert.equal(s.sessionId, null);
  assert.equal(s.account, null);
  assert.equal(s.metadataSessionId, null);
});

test("stripWithheldTools removes EndConversation from the tools array", () => {
  const reqJson = {
    model: "claude-opus-4-8",
    tools: [{ name: "Read" }, { name: "EndConversation" }, { name: "Bash" }],
  };
  const { reqJson: out, removed } = stripWithheldTools(reqJson);
  assert.deepEqual(removed, ["EndConversation"]);
  assert.deepEqual(out.tools.map((t) => t.name), ["Read", "Bash"]);
  // Source object is left untouched (shallow copy on strip).
  assert.equal(reqJson.tools.length, 3);
  assert.equal(WITHHELD_TOOLS.has("EndConversation"), true);
});

test("stripWithheldTools is a no-op (same reference) when nothing to strip", () => {
  const noTools = { model: "claude-opus-4-8", messages: [] };
  assert.equal(stripWithheldTools(noTools).reqJson, noTools);
  assert.deepEqual(stripWithheldTools(noTools).removed, []);

  const cleanTools = { tools: [{ name: "Read" }, { name: "Bash" }] };
  const res = stripWithheldTools(cleanTools);
  assert.equal(res.reqJson, cleanTools); // untouched → forwarded byte-for-byte
  assert.deepEqual(res.removed, []);

  // Non-array tools and missing body degrade without throwing.
  assert.equal(stripWithheldTools(null).reqJson, null);
  assert.deepEqual(stripWithheldTools({ tools: "nope" }).removed, []);
});

test("sidecar carries real tokens, session, and model for a non-streaming call", () => {
  const { usage, inputTokens, model } = decodeResponse(nonStreamingBody);
  const reqJson = { metadata: { user_id: JSON.stringify({ account_uuid: "acct456", session_id: "meta789" }) } };
  const audit = auditRequest(reqJson, inputTokens);
  const json = writeAuditSidecar({
    timestamp: "2026-07-20T01:15:22.069Z",
    reqJson,
    statusCode: 200,
    method: "POST",
    path: "/v1/messages?beta=true",
    audit,
    inputTokens,
    usage,
    respModel: model,
    headers: { "x-claude-code-session-id": "sess-1", "x-app": "cli-bg" },
    skim: null,
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.model, "claude-sonnet-5"); // reqJson had no model → response model fallback
  assert.equal(parsed.tokens.output, 9);
  assert.equal(parsed.tokens.cacheCreation, 38845);
  assert.equal(parsed.tokens.realInput, 38935);
  assert.equal(parsed.session.sessionId, "sess-1");
  assert.equal(parsed.session.app, "cli-bg");
  assert.equal(parsed.session.account, "acct456");
});

// ---------------------------------------------------------------------------
// Session transcripts (session.mjs)
// ---------------------------------------------------------------------------

const userText = (t) => ({ role: "user", content: [{ type: "text", text: t }] });

test("threadIdFor: stable per root, namespaced by session, null when no root", () => {
  const msgs = [userText("Fix the login bug")];
  const a = threadIdFor("sess-1", msgs);
  assert.equal(a, threadIdFor("sess-1", msgs)); // stable
  assert.notEqual(a, threadIdFor("sess-2", msgs)); // session-namespaced
  assert.notEqual(a, threadIdFor("sess-1", [userText("Different task")]));
  assert.equal(threadIdFor("sess-1", []), null);
  // A tool-result-only user turn is not a root — first *text* wins.
  assert.equal(firstUserText([{ role: "user", content: [{ type: "tool_result", content: "x" }] }, userText("real root")]), "real root");
});

test("distillMessage: task / decided+tool / error / done mapping", () => {
  assert.deepEqual(distillMessage(userText("Add a feature")), ["\n## Task: Add a feature"]);

  const assistantWithTool = {
    role: "assistant",
    content: [
      { type: "text", text: "I'll edit the file to fix it." },
      { type: "tool_use", name: "Edit", input: { file_path: "/a/b.mjs", old_string: "x", new_string: "y" } },
    ],
  };
  assert.deepEqual(distillMessage(assistantWithTool), ["- decided: I'll edit the file to fix it.", "- Edit(file_path=/a/b.mjs)"]);

  const errored = { role: "user", content: [{ type: "tool_result", is_error: true, content: "ENOENT: no such file" }] };
  assert.deepEqual(distillMessage(errored), ["- ✗ ENOENT: no such file"]);

  const plainAnswer = { role: "assistant", content: [{ type: "text", text: "All tests pass." }] };
  assert.deepEqual(distillMessage(plainAnswer), ["- done: All tests pass."]);

  // Schemas/full inputs never leak: only the allowlisted key arg is kept.
  const bash = { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la", timeout: 5000 } }] };
  assert.deepEqual(distillMessage(bash), ["- Bash(command=ls -la)"]);

  // thinking blocks are dropped.
  assert.deepEqual(distillMessages([{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }]), []);
});

test("appendSession: one-shot helper calls never get a file; real threads grow append-only", () => {
  _resetThreads();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const dir = sessionsDir(logDir);
  const headers = { "x-claude-code-session-id": "sess-A" };

  // A one-shot helper call: seen exactly once, small, never grows.
  appendSession({ logDir, reqPath: "/v1/messages", reqJson: { model: "claude-sonnet-5", messages: [userText("classify this")] }, headers });
  assert.equal(fs.existsSync(dir), false, "first sighting is buffered, not written");

  // A real agent thread: first request (buffered), then a grown follow-up (flushed).
  const m1 = [userText("Build the parser")];
  appendSession({ logDir, reqPath: "/v1/messages", reqJson: { model: "claude-opus-4-8", messages: m1 }, headers });
  const tid = threadIdFor("sess-A", m1);
  const md = path.join(dir, `${tid}.md`);
  assert.equal(fs.existsSync(md), false, "still buffered after one sighting");

  const m2 = [
    ...m1,
    { role: "assistant", content: [{ type: "text", text: "Reading the grammar first." }, { type: "tool_use", name: "Read", input: { file_path: "/g.ebnf" } }] },
    { role: "user", content: [{ type: "tool_result", is_error: true, content: "parse error at line 3" }] },
  ];
  appendSession({ logDir, reqPath: "/v1/messages", reqJson: { model: "claude-opus-4-8", messages: m2 }, headers });

  const out = fs.readFileSync(md, "utf8");
  assert.match(out, /# Session/);
  assert.match(out, /## Task: Build the parser/);
  assert.match(out, /- decided: Reading the grammar first\./);
  assert.match(out, /- Read\(file_path=\/g\.ebnf\)/);
  assert.match(out, /- ✗ parse error at line 3/);

  // A state sidecar records progress for restart recovery.
  const state = JSON.parse(fs.readFileSync(path.join(dir, `${tid}.state.json`), "utf8"));
  assert.equal(state.count, m2.length);
  assert.equal(state.started, true);

  // Append-only: a duplicate/no-growth request adds nothing.
  const before = fs.readFileSync(md, "utf8");
  appendSession({ logDir, reqPath: "/v1/messages", reqJson: { model: "claude-opus-4-8", messages: m2 }, headers });
  assert.equal(fs.readFileSync(md, "utf8"), before);

  // Restart recovery: forget in-memory state, replay m2 — the sidecar prevents re-appending.
  _resetThreads();
  appendSession({ logDir, reqPath: "/v1/messages", reqJson: { model: "claude-opus-4-8", messages: m2 }, headers });
  assert.equal(fs.readFileSync(md, "utf8"), before, "state sidecar dedupes across a restart");

  fs.rmSync(logDir, { recursive: true, force: true });
});
