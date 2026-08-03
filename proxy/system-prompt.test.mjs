/**
 * System-prompt identity and the dedup store. Zero-dependency — Node's built-in runner.
 *
 * Run:  node --test proxy/system-prompt.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPrompt, identifyPrompt, outlineWirePrompt, recordPrompt, PREAMBLE, PROMPT_STORE_DIR } from "./system-prompt.mjs";
import { auditRequest, writeAuditSidecar } from "./proxy.mjs";

const block = (text) => ({ type: "text", text });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "prompt-store-"));

test("outline counts the same bytes the sidecar records as systemBytes", () => {
  const system = [block("# A\nhello"), block("# B\nworld")];
  assert.equal(outlineWirePrompt(system).bytes, Buffer.byteLength(JSON.stringify(system)));
  assert.equal(outlineWirePrompt(system).bytes, auditRequest({ system }, 0).systemBytes);
});

test("outline splits blocks into heading spans summing to their text bytes", () => {
  const outline = outlineWirePrompt([block("intro\n# A\naaa\n## B\nbbb")]);
  assert.deepEqual(outline.sections.map((s) => s.heading), [PREAMBLE, "A", "B"]);
  assert.equal(outline.sections.reduce((a, s) => a + s.bytes, 0), outline.blocks[0].textBytes);
});

test("outline ignores headings inside fenced code", () => {
  const outline = outlineWirePrompt([block("# Real\n```sh\n# not a heading\n```\n# Also real")]);
  assert.deepEqual(outline.sections.map((s) => s.heading), ["Real", "Also real"]);
});

test("an absent system field has no identity", () => {
  assert.equal(identifyPrompt(undefined), null);
  assert.equal(identifyPrompt(null), null);
  assert.equal(outlineWirePrompt(undefined).bytes, 0);
});

test("the hash is stable for identical prompts and differs on any edit", () => {
  const a = [block("# One\nbody")];
  assert.equal(hashPrompt(a), hashPrompt([block("# One\nbody")]));
  assert.notEqual(hashPrompt(a), hashPrompt([block("# One\nbody!")]));
});

test("the sidecar carries the hash and counts, not the outline", () => {
  const system = [block("# A\nhello"), block("# B\nworld")];
  const audit = auditRequest({ system, model: "claude-opus-5" }, 10);
  const sidecar = JSON.parse(writeAuditSidecar({ timestamp: "2026-08-03T00:00:00.000Z", reqJson: { system }, statusCode: 200, method: "POST", path: "/v1/messages", audit, inputTokens: 10, usage: null }));

  assert.equal(sidecar.request.system.hash, hashPrompt(system));
  assert.equal(sidecar.request.system.blocks, 2);
  assert.equal(sidecar.request.system.sections, 2);
  assert.equal(sidecar.request.system.outline, undefined);
});

test("a request with no system prompt omits the field entirely", () => {
  const audit = auditRequest({ model: "claude-opus-5" }, 0);
  const sidecar = JSON.parse(writeAuditSidecar({ timestamp: "2026-08-03T00:00:00.000Z", reqJson: {}, statusCode: 200, method: "POST", path: "/v1/messages", audit, inputTokens: 0, usage: null }));
  assert.equal("system" in sidecar.request, false);
});

test("the store writes one file per distinct hash and reuses it after", () => {
  const dir = tmpdir();
  const first = identifyPrompt([block("# A\nhello")]);
  const second = identifyPrompt([block("# B\ndifferent")]);

  assert.equal(recordPrompt(dir, first), true);
  assert.equal(recordPrompt(dir, first), false);
  assert.equal(recordPrompt(dir, second), true);

  const stored = fs.readdirSync(path.join(dir, PROMPT_STORE_DIR)).sort();
  assert.deepEqual(stored, [`${first.hash}.json`, `${second.hash}.json`].sort());

  const record = JSON.parse(fs.readFileSync(path.join(dir, PROMPT_STORE_DIR, `${first.hash}.json`), "utf8"));
  assert.equal(record.hash, first.hash);
  assert.equal(record.bytes, first.outline.bytes);
  assert.deepEqual(record.sections.map((s) => s.heading), ["A"]);
});

test("a record already on disk is not rewritten by a later process", () => {
  const dir = tmpdir();
  const identity = identifyPrompt([block("# Shared\nbody")]);
  fs.mkdirSync(path.join(dir, PROMPT_STORE_DIR), { recursive: true });
  const file = path.join(dir, PROMPT_STORE_DIR, `${identity.hash}.json`);
  fs.writeFileSync(file, '{"hash":"pre-existing"}');

  assert.equal(recordPrompt(dir, identity), false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hash, "pre-existing");
});

test("storing never throws when the log directory is unwritable", () => {
  assert.equal(recordPrompt("/proc/nonexistent-root", identifyPrompt([block("# A\nx")])), false);
  assert.equal(recordPrompt("/tmp", null), false);
});
