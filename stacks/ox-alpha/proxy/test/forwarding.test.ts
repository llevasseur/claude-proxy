import assert from "node:assert/strict";
import test from "node:test";
import {
  type RecordedRequest,
  startFixtureUpstream,
  startProxyOnEphemeralPort,
} from "./helpers.ts";

test("proxied traffic matches direct upstream traffic byte for byte", async () => {
  const upstream = await startFixtureUpstream((req, body, res) => {
    if (req.url === "/broken") {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "x-custom": "v" });
      res.end("upstream unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-123" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
        body,
      }),
    );
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);

  try {
    for (const attempt of [
      { method: "GET", path: "/health?check=1&b=2", body: undefined },
      {
        method: "POST",
        path: "/v1/responses?api-version=2",
        body: '{"model":"gpt-5","input":"hi"}',
      },
      { method: "PUT", path: "/some/unknown/path", body: "raw bytes here" },
      { method: "DELETE", path: "/items/42?cascade=true", body: undefined },
    ] as const) {
      const headers: Record<string, string> = { authorization: "Bearer secret-token" };
      if (attempt.body !== undefined) headers["content-type"] = "application/json";

      const direct = await fetch(new URL(attempt.path, upstream.url), {
        method: attempt.method,
        headers,
        body: attempt.body,
      });
      const directText = await direct.text();

      const proxied = await fetch(new URL(attempt.path, proxy.url), {
        method: attempt.method,
        headers,
        body: attempt.body,
      });
      const proxiedText = await proxied.text();

      assert.equal(proxied.status, direct.status, `status for ${attempt.method} ${attempt.path}`);
      assert.equal(proxied.headers.get("content-type"), direct.headers.get("content-type"));
      assert.equal(proxied.headers.get("x-request-id"), direct.headers.get("x-request-id"));
      assert.equal(proxiedText, directText, `body for ${attempt.method} ${attempt.path}`);

      const recorded: RecordedRequest | undefined = upstream.requests.at(-1);
      assert.ok(recorded);
      assert.equal(recorded.method, attempt.method);
      const target = new URL(attempt.path, "http://proxy.local");
      assert.equal(recorded.url, `${target.pathname}${target.search}`);
      assert.equal(recorded.body, attempt.body ?? "");
      assert.ok(
        recorded.rawHeaders.some((value) => value === "Bearer secret-token"),
        `authorization header forwarded: ${JSON.stringify(recorded)}`,
      );
      if (attempt.body !== undefined) {
        assert.ok(
          recorded.rawHeaders.some((value) => value === "application/json"),
          "content-type forwarded",
        );
      }
    }
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("error statuses, custom headers, and streamed chunks pass through verbatim", async () => {
  const upstream = await startFixtureUpstream((_req, _body, res) => {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "x-retry-after": "7" });
    res.write("part-one ");
    setTimeout(() => {
      res.end("part-two");
    }, 10);
  });
  const proxy = await startProxyOnEphemeralPort(upstream.url);
  try {
    const response = await fetch(new URL("/anything/at/all", proxy.url));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-retry-after"), "7");
    assert.equal(await response.text(), "part-one part-two");

    const direct = await fetch(new URL("/anything/at/all", upstream.url));
    assert.equal(direct.status, 503);
  } finally {
    proxy.server.close();
    upstream.server.close();
  }
});

test("upstream connection failure answers 502 without crashing the proxy", async () => {
  // Port 1 on loopback refuses connections.
  const proxy = await startProxyOnEphemeralPort("http://127.0.0.1:1");
  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Bad Gateway\n");
  } finally {
    proxy.server.close();
  }
});
