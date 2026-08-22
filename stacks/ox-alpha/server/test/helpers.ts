import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SanitizedAuditSidecarV1 } from "@ox-alpha-proxy/core";
import type { ServerConfig } from "../src/config.ts";

export async function temporaryDirectory(): Promise<
  Readonly<{ path: string; cleanup: () => Promise<void> }>
> {
  const path = await mkdtemp(join(tmpdir(), "ox-alpha-proxy-server-"));
  return Object.freeze({ path, cleanup: () => rm(path, { recursive: true, force: true }) });
}

export function sidecar(
  recordId: string,
  timestamp = "2026-08-19T16:00:00.000Z",
  options: Readonly<{ unavailable?: boolean; inputTokens?: number; outputTokens?: number }> = {},
): SanitizedAuditSidecarV1 {
  const inputTokens = options.inputTokens ?? 10;
  const outputTokens = options.outputTokens ?? 4;
  return Object.freeze({
    schemaVersion: 1,
    recordId,
    timestamp,
    model: "gpt-5",
    endpoint: "/v1/responses",
    responseStatus: 200,
    requestId: `request-${recordId}`,
    usage: Object.freeze({
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    }),
    cost: options.unavailable
      ? null
      : Object.freeze({ currency: "USD", amountUsd: "0.000053", catalogueVersion: "test" }),
    costUnavailableReason: options.unavailable
      ? Object.freeze({ code: "unknown-model", model: "future" })
      : null,
  });
}

export async function writeSidecar(
  directory: string,
  filename: string,
  value: unknown,
): Promise<void> {
  await writeFile(join(directory, filename), JSON.stringify(value));
}

export function config(directory: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return Object.freeze({
    host: "127.0.0.1",
    port: 0,
    auditDirectory: directory,
    databasePath: join(directory, "usage.db"),
    proxyStatusPath: join(directory, "proxy-status.json"),
    reportTimezone: "America/New_York",
    reconcileIntervalMs: 60_000,
    keepaliveIntervalMs: 25,
    ...overrides,
  });
}
