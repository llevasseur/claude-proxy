import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LiveUsageService } from "../src/service.ts";
import { config, sidecar, temporaryDirectory, writeSidecar } from "./helpers.ts";

const services: LiveUsageService[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 500,
): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for SSE")), timeoutMs),
    ),
  ]);
  return new TextDecoder().decode(result.value);
}

function ids(value: string): number[] {
  return [...value.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

test("SSE sends snapshots, updates, keepalives, monotonic reconnect IDs, and cleans up subscribers", async () => {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  const now = new Date("2026-08-19T18:00:00.000Z");
  const service = new LiveUsageService(config(temporary.path), () => now);
  services.push(service);
  const address = await service.start();
  const origin = `http://${address.host}:${address.port}`;

  const firstResponse = await fetch(`${origin}/api/events`);
  const firstBody = firstResponse.body;
  if (!firstBody) throw new Error("missing SSE body");
  const firstReader = firstBody.getReader();
  let initial = "";
  while (!initial.includes("event: snapshot")) initial += await nextChunk(firstReader);
  expect(initial).toContain("retry: 2000");
  expect(initial).toContain("event: snapshot");
  expect(initial).toContain('"requestCount":0');
  const initialId = ids(initial)[0];
  if (initialId === undefined) throw new Error("snapshot missing event id");
  const connectedHealth = (await fetch(`${origin}/api/health`).then((response) =>
    response.json(),
  )) as { sse: { subscribers: number } };
  expect(connectedHealth.sse.subscribers).toBe(1);

  await writeSidecar(temporary.path, "live.audit.json", sidecar("live"));
  await service.reconcile();
  let update = "";
  while (!update.includes("event: update")) update += await nextChunk(firstReader);
  expect(update).toContain('"requestCount":1');
  const updateId = ids(update).at(-1);
  if (updateId === undefined) throw new Error("update missing event id");
  expect(updateId).toBeGreaterThan(initialId);

  await service.reconcile();
  const keepalive = await nextChunk(firstReader);
  expect(keepalive).toContain(": keepalive");
  expect(keepalive).not.toContain("event: update");

  await writeFile(
    join(temporary.path, "proxy-status.json"),
    JSON.stringify({ state: "upstream-error", updatedAt: "2026-08-19T18:00:00.000Z" }),
  );
  await service.refresh();
  let statusUpdate = "";
  while (!statusUpdate.includes("event: update")) statusUpdate += await nextChunk(firstReader);
  expect(statusUpdate).toContain('"state":"upstream-error"');
  const statusId = ids(statusUpdate).at(-1);
  if (statusId === undefined) throw new Error("status update missing event id");
  expect(statusId).toBeGreaterThan(updateId);

  const reconnectResponse = await fetch(`${origin}/api/events`, {
    headers: { "last-event-id": String(updateId) },
  });
  const reconnectBody = reconnectResponse.body;
  if (!reconnectBody) throw new Error("missing reconnect body");
  const reconnectReader = reconnectBody.getReader();
  let reconnect = "";
  while (!reconnect.includes("event: snapshot")) reconnect += await nextChunk(reconnectReader);
  expect(reconnect).toContain("event: snapshot");
  expect(ids(reconnect)[0]).toBeGreaterThan(statusId);

  await firstReader.cancel();
  await reconnectReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const disconnectedHealth = (await fetch(`${origin}/api/health`).then((response) =>
    response.json(),
  )) as { sse: { subscribers: number } };
  expect(disconnectedHealth.sse.subscribers).toBe(0);
});

test("proxy rolling usage from the status file rides the snapshot and updates", async () => {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  const now = new Date("2026-08-19T18:00:00.000Z");
  const service = new LiveUsageService(config(temporary.path), () => now);
  services.push(service);
  const address = await service.start();
  const origin = `http://${address.host}:${address.port}`;

  const response = await fetch(`${origin}/api/events`);
  const body = response.body;
  if (!body) throw new Error("missing SSE body");
  const reader = body.getReader();
  let initial = "";
  while (!initial.includes("event: snapshot")) initial += await nextChunk(reader);
  expect(initial).toContain('"rollingUsage":null');

  const rollingUsage = {
    windowStartedAt: "2026-08-19T17:00:00.000Z",
    requests: 2,
    inputTokens: 130,
    cachedInputTokens: 20,
    outputTokens: 62,
    reasoningOutputTokens: 10,
    totalTokens: 192,
  };
  await writeFile(
    join(temporary.path, "proxy-status.json"),
    JSON.stringify({ state: "ready", updatedAt: now.toISOString(), rollingUsage }),
  );
  await service.refresh();
  let update = "";
  while (!update.includes("event: update")) update += await nextChunk(reader);
  expect(update).toContain('"rollingUsage":{"windowStartedAt":"2026-08-19T17:00:00.000Z"');
  expect(update).toContain('"totalTokens":192');

  const health = (await fetch(`${origin}/api/health`).then((r) => r.json())) as {
    proxy: { rollingUsage?: { requests?: number } | null };
  };
  expect(health.proxy.rollingUsage?.requests).toBe(2);

  // A malformed rolling payload degrades to null rather than poisoning health.
  await writeFile(
    join(temporary.path, "proxy-status.json"),
    JSON.stringify({
      state: "ready",
      updatedAt: now.toISOString(),
      rollingUsage: { requests: "x" },
    }),
  );
  await service.refresh();
  let degraded = "";
  while (!degraded.includes('"rollingUsage":null')) degraded += await nextChunk(reader);
  expect(degraded).toContain("event: update");

  await reader.cancel();
});
