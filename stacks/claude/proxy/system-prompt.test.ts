/**
 * System-prompt identity and the dedup store. Zero-dependency — Node's built-in
 * runner, which strips the types itself.
 *
 * Run:  node --test proxy/system-prompt.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditRequest, writeAuditSidecar } from './proxy.ts';
import {
  hashPrompt,
  identifyPrompt,
  outlineWirePrompt,
  PREAMBLE,
  PROMPT_STORE_DIR,
  type PromptIdentity,
  type PromptSection,
  recordPrompt,
} from './system-prompt.ts';

const block = (text: string) => ({ type: 'text', text });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-store-'));

/** The sidecar's `request` object, as far as these tests read it. */
interface SidecarRequest {
  system?: { hash: string; blocks: number; sections: number; outline?: unknown };
}

const requestOf = (json: string): SidecarRequest => {
  // SAFETY: `json` is what `writeAuditSidecar` returned a line earlier in the same
  // test, so `request` is the object that call built.
  const sidecar = JSON.parse(json) as { request: SidecarRequest };
  return sidecar.request;
};

test('outline counts the same bytes the sidecar records as systemBytes', () => {
  const system = [block('# A\nhello'), block('# B\nworld')];
  assert.equal(outlineWirePrompt(system).bytes, Buffer.byteLength(JSON.stringify(system)));
  assert.equal(outlineWirePrompt(system).bytes, auditRequest({ system }, 0).systemBytes);
});

test('outline splits blocks into heading spans summing to their text bytes', () => {
  const outline = outlineWirePrompt([block('intro\n# A\naaa\n## B\nbbb')]);
  assert.deepEqual(
    outline.sections.map((s) => s.heading),
    [PREAMBLE, 'A', 'B'],
  );
  assert.equal(
    outline.sections.reduce((a, s) => a + s.bytes, 0),
    outline.blocks[0]?.textBytes,
  );
});

test('outline ignores headings inside fenced code', () => {
  const outline = outlineWirePrompt([block('# Real\n```sh\n# not a heading\n```\n# Also real')]);
  assert.deepEqual(
    outline.sections.map((s) => s.heading),
    ['Real', 'Also real'],
  );
});

test('an absent system field has no identity', () => {
  assert.equal(identifyPrompt(undefined), null);
  assert.equal(identifyPrompt(null), null);
  assert.equal(outlineWirePrompt(undefined).bytes, 0);
});

test('the hash is stable for identical prompts and differs on any edit', () => {
  const a = [block('# One\nbody')];
  assert.equal(hashPrompt(a), hashPrompt([block('# One\nbody')]));
  assert.notEqual(hashPrompt(a), hashPrompt([block('# One\nbody!')]));
});

test('the sidecar carries the hash and counts, not the outline', () => {
  const system = [block('# A\nhello'), block('# B\nworld')];
  const audit = auditRequest({ system, model: 'claude-opus-5' }, 10);
  const request = requestOf(
    writeAuditSidecar({
      timestamp: '2026-08-03T00:00:00.000Z',
      reqJson: { system },
      statusCode: 200,
      method: 'POST',
      path: '/v1/messages',
      audit,
      inputTokens: 10,
      usage: null,
    }),
  );

  assert.equal(request.system?.hash, hashPrompt(system));
  assert.equal(request.system?.blocks, 2);
  assert.equal(request.system?.sections, 2);
  assert.equal(request.system?.outline, undefined);
});

test('a request with no system prompt omits the field entirely', () => {
  const audit = auditRequest({ model: 'claude-opus-5' }, 0);
  const request = requestOf(
    writeAuditSidecar({
      timestamp: '2026-08-03T00:00:00.000Z',
      reqJson: {},
      statusCode: 200,
      method: 'POST',
      path: '/v1/messages',
      audit,
      inputTokens: 0,
      usage: null,
    }),
  );
  assert.equal('system' in request, false);
});

test('the store writes one file per distinct hash and reuses it after', () => {
  const dir = tmpdir();
  // SAFETY: `identifyPrompt` returns null only for an absent `system` field; this
  // passes a one-block array.
  const first = identifyPrompt([block('# A\nhello')]) as PromptIdentity;
  // SAFETY: same — a one-block array, so the null return is unreachable here.
  const second = identifyPrompt([block('# B\ndifferent')]) as PromptIdentity;

  assert.equal(recordPrompt(dir, first), true);
  assert.equal(recordPrompt(dir, first), false);
  assert.equal(recordPrompt(dir, second), true);

  const stored = fs.readdirSync(path.join(dir, PROMPT_STORE_DIR)).sort();
  assert.deepEqual(stored, [`${first.hash}.json`, `${second.hash}.json`].sort());

  // SAFETY: `recordPrompt` wrote this file from `first`, so its three fields are the
  // ones that call serialized.
  const record = JSON.parse(fs.readFileSync(path.join(dir, PROMPT_STORE_DIR, `${first.hash}.json`), 'utf8')) as {
    hash: string;
    bytes: number;
    sections: PromptSection[];
  };
  assert.equal(record.hash, first.hash);
  assert.equal(record.bytes, first.outline.bytes);
  assert.deepEqual(
    record.sections.map((s) => s.heading),
    ['A'],
  );
});

test('a record already on disk is not rewritten by a later process', () => {
  const dir = tmpdir();
  // SAFETY: `identifyPrompt` returns null only for an absent `system` field, and this
  // call passes a one-block array.
  const identity = identifyPrompt([block('# Shared\nbody')]) as PromptIdentity;
  fs.mkdirSync(path.join(dir, PROMPT_STORE_DIR), { recursive: true });
  const file = path.join(dir, PROMPT_STORE_DIR, `${identity.hash}.json`);
  fs.writeFileSync(file, '{"hash":"pre-existing"}');

  assert.equal(recordPrompt(dir, identity), false);
  // SAFETY: this test wrote `{"hash":"pre-existing"}` to `file` itself, so the parsed
  // value is that literal or the assertion fails.
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { hash: string }).hash, 'pre-existing');
});

/**
 * Run `fn` with the console captured, returning its result and what it wrote.
 *
 * An unwritable log directory is reported to the console, and the test below drives
 * that path on purpose. Under `node --test` each file runs in a child process whose
 * stdout and stderr are pipes back to the runner, and writing to that pipe is what
 * left this file's child alive forever in CI while the same run passed on macOS.
 * Capturing the write turns the report into an assertion and leaves nothing writing
 * to the pipe.
 */
function captureConsole<T>(fn: () => T) {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  const warn = console.warn;
  const error = console.error;
  console.warn = record;
  console.error = record;
  try {
    return { result: fn(), output: lines.join('\n') };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

test('storing never throws when the log directory is unwritable', () => {
  const unwritable = captureConsole(() => recordPrompt('/proc/nonexistent-root', identifyPrompt([block('# A\nx')])));
  assert.equal(unwritable.result, false);
  assert.match(unwritable.output, /could not store system prompt outline/);

  // A null identity is not an error, so it reports nothing.
  const absent = captureConsole(() => recordPrompt('/tmp', null));
  assert.equal(absent.result, false);
  assert.equal(absent.output, '');
});
