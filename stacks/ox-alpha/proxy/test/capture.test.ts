import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseSanitizedAuditSidecar } from "../../packages/core/src/index.ts";
import { loadProxyConfig } from "../src/config.ts";
import {
  removeDirectory,
  startFixtureUpstream,
  startProxyOnEphemeralPort,
  waitForCaptureFiles,
  waitForFiles,
} from "./helpers.ts";

const SECRET_PROMPT = "top-secret-prompt-do-not-store";
const SECRET_KEY = "sk-live-0123456789abcdef";
const SECRET_TOKEN = "Bearer abcdef1234567890secret";

async function listFilesRecursively(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await listFilesRecursively(path)));
      else files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

test("capture off keeps forwarding byte-identical and never writes body bytes to disk", async () => {
  const upstream = await startFixtureUpstream((req, body, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-1" });
    res.end(
      JSON.stringify({
        echoed: body,
        authorization: req.headers.authorization,
        // Valid final Responses shape so Bike's sanitized sidecar still lands.
        object: "response",
        model: "gpt-5",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }),
    );
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  const requestBody = JSON.stringify({ model: "gpt-5", input: SECRET_PROMPT });

  try {
    const direct = await fetch(new URL("/v1/responses", upstream.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET_TOKEN },
      body: requestBody,
    });
    const directText = await direct.text();

    const proxied = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET_TOKEN },
      body: requestBody,
    });
    assert.equal(proxied.status, direct.status);
    assert.equal(proxied.headers.get("content-type"), direct.headers.get("content-type"));
    assert.equal(await proxied.text(), directText, "forwarded bytes must be identical");

    // Observation still runs with capture off; wait for its sidecar so every
    // asynchronous proxy write has settled before scanning and cleaning up.
    const sidecarFiles = await waitForFiles(proxy.auditDirectory, 1);
    assert.equal(sidecarFiles.length, 1);

    // No capture file anywhere under the proxy's scratch base, and no disk
    // file at all contains the secret bodies.
    const files = await listFilesRecursively(proxy.baseDirectory);
    assert.equal(
      files.filter((file) => file.endsWith(".capture.json")).length,
      0,
      "no capture files with capture disabled",
    );
    for (const file of files) {
      const contents = await readFile(file, "utf8").catch(() => "");
      assert.ok(!contents.includes(SECRET_PROMPT), `${file} must not hold the prompt`);
      assert.ok(!contents.includes(SECRET_TOKEN), `${file} must not hold the token`);
    }
  } finally {
    proxy.server.close();
    upstream.server.close();
    await removeDirectory(proxy.baseDirectory);
  }
});

test("capture on redacts secrets before persistence and leaves sidecar v1 untouched", async () => {
  let streamedChunksSent = false;
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-2" });
    res.write(`event: response.completed\ndata: {"secret":"${SECRET_KEY}"}\n\n`);
    setTimeout(() => {
      streamedChunksSent = true;
      res.write(
        `data: {"type":"response.completed","response":{"object":"response","model":"gpt-5",` +
          `"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n`,
      );
      res.end();
    }, 10);
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url, {
    CAPTURE_BODIES: "1",
    CAPTURE_REDACT_PATTERNS: "top-secret-[a-z-]+",
  });
  const requestBody = JSON.stringify({
    model: "gpt-5",
    input: SECRET_PROMPT,
    authorization: `Bearer ${SECRET_KEY}`,
  });

  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    const streamed = await response.text();
    assert.ok(streamedChunksSent);
    // Forwarding stays transparent: upstream bytes reach the client verbatim,
    // including their secrets. Redaction applies only to persisted captures.
    assert.ok(streamed.includes(SECRET_KEY));
    assert.ok(streamed.includes("response.completed"), "SSE still streams through verbatim");

    const sidecarFiles = await waitForFiles(proxy.auditDirectory, 1);
    const captureFiles = await waitForCaptureFiles(proxy.captureDirectory, 1);
    const [sidecarFile] = sidecarFiles;
    const [captureFile] = captureFiles;
    assert.ok(sidecarFile, "sidecar written");
    assert.ok(captureFile, "capture written");
    const envelope = JSON.parse(await readFile(join(proxy.captureDirectory, captureFile), "utf8"));
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.endpoint, "/v1/responses");
    for (const secret of [SECRET_PROMPT, SECRET_KEY, SECRET_TOKEN]) {
      assert.ok(!envelope.requestText.includes(secret), "request secret redacted pre-persistence");
      assert.ok(!envelope.responseText.includes(secret), "response secret redacted");
    }
    assert.ok(envelope.requestText.includes("[redacted]"));
    assert.ok(envelope.responseText.includes("[redacted]"));

    // Sidecars stay exactly v1: same fields, same schema, joined by recordId.
    const sidecar = parseSanitizedAuditSidecar(
      JSON.parse(await readFile(join(proxy.auditDirectory, sidecarFile), "utf8")),
    );
    assert.equal(sidecar.schemaVersion, 1);
    assert.equal(sidecar.recordId, envelope.recordId);
    assert.equal(sidecar.usage.totalTokens, 5);

    // Capture files never land beside sanitized sidecars.
    const auditFiles = await readdir(proxy.auditDirectory);
    assert.ok(auditFiles.every((name) => !name.endsWith(".capture.json")));
  } finally {
    proxy.server.close();
    upstream.server.close();
    await removeDirectory(proxy.baseDirectory);
  }
});

test("invalid capture configuration fails fast at startup", () => {
  assert.throws(
    () =>
      loadProxyConfig({
        OPENAI_UPSTREAM: "https://api.openai.com",
        CAPTURE_BODIES: "maybe",
      }),
    /CAPTURE_BODIES/,
  );
  assert.throws(
    () =>
      loadProxyConfig({
        OPENAI_UPSTREAM: "https://api.openai.com",
        CAPTURE_BODIES: "1",
        CAPTURE_REDACT_PATTERNS: "([unclosed",
      }),
    /Invalid regular expression|Invalid/,
  );
});
