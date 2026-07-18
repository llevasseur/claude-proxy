import type { AuditSidecar, AuditSkim, AuditTool } from "../src/types.js";

/** Build a valid audit sidecar for tests; override any field. */
export function makeSidecar(overrides: Partial<AuditSidecar> = {}): AuditSidecar {
  const tools: AuditTool[] = overrides.tools ?? [
    { name: "Workflow", bytes: 20_000, estTokens: 5_000 },
    { name: "Bash", bytes: 4_000, estTokens: 1_000 },
  ];
  return {
    timestamp: "2026-07-15T13:47:49.191Z",
    model: "claude-opus-4-8",
    endpoint: "POST /v1/messages",
    statusCode: 200,
    tokens: { input: 100, output: 500, cacheRead: 8_000, cacheCreation: 1_000, realInput: 9_100 },
    request: { toolCount: tools.length, toolsBytes: 24_000, systemBytes: 8_000, totalBytes: 60_000 },
    tools,
    ...overrides,
  };
}

/** A default-off skim block; override to simulate hits/misses. */
export function makeSkim(overrides: Partial<AuditSkim> = {}): AuditSkim {
  return { enabled: false, servedFromCache: false, savedInputTokens: 0, cacheKey: null, ...overrides };
}
