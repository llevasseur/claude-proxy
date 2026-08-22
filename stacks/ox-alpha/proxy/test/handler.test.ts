import assert from "node:assert/strict";
import test from "node:test";
import { createProxyServer } from "../src/handler.ts";

test("createProxyServer returns an http server", () => {
  const server = createProxyServer("http://localhost:1");
  assert.equal(typeof server.listen, "function");
  server.close();
});

test("unimplemented forwarding answers 502", async () => {
  const server = createProxyServer("http://localhost:1");
  const url = new URL("http://localhost/");
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      url.port = String(address.port);
      resolve();
    });
  });
  try {
    const response = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /not yet implemented/);
  } finally {
    server.close();
  }
});
