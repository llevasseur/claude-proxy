import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parseSanitizedAuditSidecar } from "../../packages/core/src/index.ts";
import { startFixtureUpstream, startProxyOnEphemeralPort, waitForFiles } from "./helpers.ts";

const COMPLETED_USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 20 },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 150,
};

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readSidecar(
  directory: string,
): Promise<ReturnType<typeof parseSanitizedAuditSidecar>> {
  const [file] = await waitForFiles(directory, 1);
  return parseSanitizedAuditSidecar(JSON.parse(await readFile(`${directory}/${file}`, "utf8")));
}

test("extracts usage from a streaming Responses exchange without altering bytes", async () => {
  const events = [
    sseEvent("response.created", {
      type: "response.created",
      response: { object: "response", model: "gpt-5", usage: null },
    }),
    sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "hel" }),
    sseEvent("response.completed", {
      type: "response.completed",
      response: { object: "response", model: "gpt-5", usage: COMPLETED_USAGE },
    }),
    "data: [DONE]\n\n",
  ];
  const wire = Buffer.from(events.join(""), "utf8");
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-sse" });
    res.write(events[0]);
    setTimeout(() => res.end(Buffer.from(events.slice(1).join(""), "utf8")), 10);
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "hello", stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(new Uint8Array(await response.arrayBuffer()).length, wire.length);

    const sidecar = await readSidecar(proxy.auditDirectory);
    assert.equal(sidecar.model, "gpt-5");
    assert.equal(sidecar.endpoint, "/v1/responses");
    assert.equal(sidecar.responseStatus, 200);
    assert.equal(sidecar.requestId, "req-sse");
    assert.deepEqual(
      { ...sidecar.usage },
      {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalTokens: 150,
      },
    );
    // 80 uncached input * 1.25 + 20 cached * 0.125 + 40 output * 10 + 10 reasoning * 10
    // per million tokens, computed in pico-dollars by core.
    assert.equal(sidecar.cost?.amountUsd, "0.0006025");
    assert.equal(sidecar.costUnavailableReason, null);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const files = await readdir(proxy.auditDirectory);
    assert.equal(
      files.filter((name) => name.endsWith(".audit.json")).length,
      1,
      "exactly one sidecar",
    );
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("extracts usage from a non-streaming Responses JSON body", async () => {
  const responseBody = JSON.stringify({
    object: "response",
    model: "gpt-5-mini",
    usage: {
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 42,
    },
  });
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(responseBody);
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", input: "hi" }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), responseBody);

    const sidecar = await readSidecar(proxy.auditDirectory);
    assert.equal(sidecar.model, "gpt-5-mini");
    assert.equal(sidecar.usage.totalTokens, 42);
    // 30 uncached input * 0.25 + 12 output * 2.00 per million tokens.
    assert.equal(sidecar.cost?.amountUsd, "0.0000315");
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("unknown traffic passes through with no sidecar written", async () => {
  const upstream = await startFixtureUpstream((_req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echoed: body }));
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    const response = await fetch(new URL("/v1/chat/completions", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.match((JSON.parse(await response.text()) as { echoed: string }).echoed, /gpt-4o/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const files = await readdir(proxy.auditDirectory).catch(() => [] as string[]);
    assert.equal(
      files.filter((name) => name.endsWith(".audit.json")).length,
      0,
      "no sidecar for unknown traffic",
    );
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("a malformed final SSE event never breaks the already-streamed response", async () => {
  const events = [
    sseEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "ok" }),
    sseEvent("response.completed", {
      type: "response.completed",
      response: {
        object: "response",
        model: "gpt-5",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 999 },
          output_tokens: 5,
          output_tokens_details: {},
          total_tokens: 15,
        },
      },
    }),
    "data: [DONE]\n\n",
  ];
  const wire = events.join("");
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(wire);
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "hi", stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      wire,
      "invalid usage in completed event cannot alter stream bytes",
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    const files = await readdir(proxy.auditDirectory).catch(() => [] as string[]);
    assert.equal(
      files.filter((name) => name.endsWith(".audit.json")).length,
      0,
      "invalid usage writes no sidecar",
    );
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});
