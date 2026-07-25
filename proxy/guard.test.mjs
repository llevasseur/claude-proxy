/**
 * Unit tests for the permission-config guard. Zero-dependency — Node's built-in
 * test runner.
 *
 * The two properties that matter: a clean reply is forwarded byte-for-byte, and a
 * refused call never reaches the CLI in any framing — split chunks, non-streaming
 * bodies, or cache replays.
 *
 * Run:  node --test proxy/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ResponseGuard, guardBuffer, inspectToolUse } from "./guard.mjs";

const evt = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

/** A complete streamed tool call, as the API frames it. */
function toolUseStream(name, input, { index = 0, stop_reason = "tool_use" } = {}) {
  const json = JSON.stringify(input);
  return (
    evt({ type: "message_start", message: { usage: { input_tokens: 10 }, model: "claude-opus-5" } }) +
    evt({ type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name } }) +
    // Split across two deltas, as a real stream does.
    evt({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 8) } }) +
    evt({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(8) } }) +
    evt({ type: "content_block_stop", index }) +
    evt({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 5 } })
  );
}

const run = (raw, chunkSize) => {
  const g = new ResponseGuard();
  let out = "";
  if (chunkSize) {
    for (let i = 0; i < raw.length; i += chunkSize) out += g.push(Buffer.from(raw.slice(i, i + chunkSize)));
  } else {
    out += g.push(Buffer.from(raw));
  }
  return { out: out + g.flush(), guard: g };
};

// --- inspectToolUse: what counts as permission config ------------------------

test("inspectToolUse refuses file writes to permission config", () => {
  for (const p of [
    ".claude/settings.json",
    ".claude/settings.local.json",
    "/Users/me/repo/.claude/settings.json",
    "/Users/me/.claude/hooks/pre.sh",
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
  ]) {
    assert.ok(inspectToolUse("Write", { file_path: p }), `should refuse ${p}`);
  }
});

test("inspectToolUse allows ordinary file writes", () => {
  for (const p of ["src/app.ts", "proxy/proxy.mjs", ".claude/worktrees/x/src/a.ts", "docs/settings.json"]) {
    assert.equal(inspectToolUse("Write", { file_path: p }), null, `should allow ${p}`);
  }
});

test("inspectToolUse refuses shell writes to permission config", () => {
  for (const c of [
    "cat > .claude/settings.json <<'EOF'\n{}\nEOF",
    "echo '{}' >> ~/.claude/settings.json",
    "sed -i '' 's/a/b/' .claude/settings.json",
    "tee .claude/settings.json",
    "rm .claude/settings.local.json",
    "python3 -c 'open(\".claude/settings.json\",\"w\")'",
  ]) {
    assert.ok(inspectToolUse("Bash", { command: c }), `should refuse: ${c}`);
  }
});

test("inspectToolUse allows reading permission config", () => {
  for (const c of ["cat .claude/settings.json", "grep permissions .claude/settings.json", "ls -la .claude/"]) {
    assert.equal(inspectToolUse("Bash", { command: c }), null, `should allow: ${c}`);
  }
});

test("inspectToolUse ignores tools that cannot write and malformed input", () => {
  assert.equal(inspectToolUse("Read", { file_path: ".claude/settings.json" }), null);
  assert.equal(inspectToolUse("Grep", { path: ".claude/settings.json" }), null);
  assert.equal(inspectToolUse("Write", null), null);
  assert.equal(inspectToolUse("Write", {}), null);
});

// --- ResponseGuard: transparency on the happy path ---------------------------

test("a clean tool call is forwarded byte-for-byte", () => {
  const raw = toolUseStream("Write", { file_path: "src/app.ts", content: "hi" });
  const { out, guard } = run(raw);
  assert.equal(out, raw, "clean stream must be unchanged");
  assert.equal(guard.blocked.length, 0);
});

test("a reply with no tool calls is forwarded byte-for-byte", () => {
  const raw =
    evt({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    evt({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }) +
    evt({ type: "content_block_stop", index: 0 }) +
    evt({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  assert.equal(run(raw).out, raw);
});

// --- ResponseGuard: refusal --------------------------------------------------

test("a write to permission config is replaced and the turn ends", () => {
  const raw = toolUseStream("Write", { file_path: ".claude/settings.json", content: "{}" });
  const { out, guard } = run(raw);

  assert.equal(guard.blocked.length, 1);
  assert.equal(guard.blocked[0].tool, "Write");
  assert.ok(!out.includes("tool_use"), "the tool_use block must not reach the CLI");
  assert.ok(out.includes("Refused `Write`"), "the agent is told what happened");
  assert.ok(out.includes('"stop_reason":"end_turn"'), "stop_reason must not still promise a tool call");
});

test("a shell write to permission config is refused too", () => {
  const raw = toolUseStream("Bash", { command: "echo '{}' > .claude/settings.json" });
  const { out, guard } = run(raw);
  assert.equal(guard.blocked.length, 1);
  assert.ok(!out.includes("tool_use"));
  assert.ok(out.includes("Refused `Bash`"));
});

test("refusal survives chunk boundaries that split every event", () => {
  const raw = toolUseStream("Write", { file_path: ".claude/settings.json", content: "{}" });
  for (const size of [1, 7, 64]) {
    const { out, guard } = run(raw, size);
    assert.equal(guard.blocked.length, 1, `chunk size ${size}`);
    assert.ok(!out.includes("tool_use"), `chunk size ${size} leaked the call`);
  }
});

test("a clean call alongside a refused one keeps its tool result", () => {
  const clean = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "Write" } };
  const raw =
    evt(clean) +
    evt({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"src/a.ts"}' } }) +
    evt({ type: "content_block_stop", index: 0 }) +
    evt({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "b", name: "Write" } }) +
    evt({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":".claude/settings.json"}' } }) +
    evt({ type: "content_block_stop", index: 1 }) +
    evt({ type: "message_delta", delta: { stop_reason: "tool_use" } });

  const { out, guard } = run(raw);
  assert.equal(guard.blocked.length, 1, "only the config write is refused");
  assert.ok(out.includes('"id":"a"'), "the clean call still reaches the CLI");
  assert.ok(!out.includes('"id":"b"'), "the refused call does not");
  assert.ok(out.includes('"stop_reason":"tool_use"'), "stop_reason stays: a real call is still pending");
});

// --- guardBuffer: non-streaming and cache replay -----------------------------

test("guardBuffer refuses a tool call in a non-streaming body", () => {
  const body = Buffer.from(JSON.stringify({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: ".claude/settings.json" } }],
  }));
  const { body: out, blocked } = guardBuffer(body);
  const parsed = JSON.parse(out.toString("utf8"));

  assert.equal(blocked.length, 1);
  assert.equal(parsed.content[0].type, "text");
  assert.equal(parsed.stop_reason, "end_turn");
});

test("guardBuffer returns the original buffer when nothing is refused", () => {
  const body = Buffer.from(JSON.stringify({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "src/a.ts" } }],
  }));
  const out = guardBuffer(body);
  assert.equal(out.body, body, "same reference — untouched");
  assert.equal(out.blocked.length, 0);
});

test("guardBuffer guards a replayed SSE body", () => {
  const raw = toolUseStream("Write", { file_path: ".claude/settings.json", content: "{}" });
  const { body, blocked } = guardBuffer(Buffer.from(raw));
  assert.equal(blocked.length, 1);
  assert.ok(!body.toString("utf8").includes("tool_use"));
});

test("guardBuffer tolerates a non-JSON body", () => {
  const body = Buffer.from("not json at all");
  assert.equal(guardBuffer(body).body, body);
});
