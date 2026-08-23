import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadProxyConfig } from "../src/config.ts";

const STACK_ROOT = resolve(import.meta.dirname, "..", "..");

test("an unconfigured proxy binds and forwards where this proxy actually runs", () => {
  const config = loadProxyConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8807);
  assert.equal(config.upstream.origin, "https://opencode.ai");
});

test("relative paths resolve against the stack root, not the launching cwd", () => {
  const config = loadProxyConfig({});
  assert.equal(config.auditDirectory, resolve(STACK_ROOT, "logs/audit"));
  assert.equal(config.statusFile, resolve(STACK_ROOT, "logs/audit/proxy-status.json"));
  assert.equal(config.captureDirectory, resolve(STACK_ROOT, "logs/captures"));

  const relative = loadProxyConfig({
    AUDIT_DIR: "logs/elsewhere",
    PROXY_STATUS_FILE: "logs/state.json",
    CAPTURE_DIR: "logs/caps",
  });
  assert.equal(relative.auditDirectory, resolve(STACK_ROOT, "logs/elsewhere"));
  assert.equal(relative.statusFile, resolve(STACK_ROOT, "logs/state.json"));
  assert.equal(relative.captureDirectory, resolve(STACK_ROOT, "logs/caps"));
});

test("OX_PROXY_PORT wins over the bare PROXY_PORT", () => {
  assert.equal(loadProxyConfig({ OX_PROXY_PORT: "9101", PROXY_PORT: "9102" }).port, 9101);
});

test("the bare PROXY_PORT still resolves on its own", () => {
  assert.equal(loadProxyConfig({ PROXY_PORT: "9103" }).port, 9103);
});

test("the default port is unchanged when neither name is set", () => {
  assert.equal(loadProxyConfig({}).port, 8807);
});

test("a bad value reports whichever name the operator supplied", () => {
  assert.throws(() => loadProxyConfig({ OX_PROXY_PORT: "70000" }), /^Error: OX_PROXY_PORT must be/);
  assert.throws(() => loadProxyConfig({ PROXY_PORT: "70000" }), /^Error: PROXY_PORT must be/);
});

test("PROXY_PORT and OPENAI_UPSTREAM override the defaults", () => {
  assert.equal(loadProxyConfig({ PROXY_PORT: "0" }).port, 0);
  assert.equal(
    loadProxyConfig({ OPENAI_UPSTREAM: "https://api.openai.com" }).upstream.origin,
    "https://api.openai.com",
  );
});

test("OPENAI_UPSTREAM rejects a non-HTTP protocol", () => {
  assert.throws(() => loadProxyConfig({ OPENAI_UPSTREAM: "ftp://example.com" }), /http or https/);
});
