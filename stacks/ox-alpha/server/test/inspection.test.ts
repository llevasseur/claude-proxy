import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureEnvelopeV1 } from "@ox-alpha-proxy/core";
import { afterEach, describe, expect, test } from "vitest";
import type { ServerConfig } from "../src/config.ts";
import { LiveUsageService } from "../src/service.ts";
import { config, temporaryDirectory } from "./helpers.ts";

const services: LiveUsageService[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function start(
  now: Date,
  prepare?: (directory: string) => Promise<void>,
  overrides: Partial<ServerConfig> = {},
): Promise<{ service: LiveUsageService; origin: string; directory: string }> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  await prepare?.(temporary.path);
  const service = new LiveUsageService(config(temporary.path, overrides), () => now);
  services.push(service);
  const address = await service.start();
  return { service, origin: `http://${address.host}:${address.port}`, directory: temporary.path };
}

async function writeCapture(directory: string, envelopeValue: CaptureEnvelopeV1): Promise<void> {
  const captureDir = join(directory, "captures");
  await mkdir(captureDir, { recursive: true });
  await writeFile(
    join(captureDir, `${envelopeValue.capturedAt}_${envelopeValue.recordId}.capture.json`),
    JSON.stringify(envelopeValue),
  );
}

const NOW = new Date("2026-08-20T18:00:00.000Z");

function requestBody(sessionId?: string): string {
  return JSON.stringify({
    model: "gpt-5",
    instructions: "Be terse.",
    ...(sessionId ? { session_id: sessionId } : {}),
    input: [
      { role: "user", type: "message", content: [{ type: "input_text", text: "hello there" }] },
      { role: "assistant", content: "earlier turn" },
    ],
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Weather lookup",
        parameters: { type: "object" },
      },
    ],
  });
}

function responseBody(withToolCall: boolean): string {
  const output: Array<Record<string, unknown>> = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "sunny" }] },
  ];
  if (withToolCall) {
    output.push({
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
  }
  return JSON.stringify({ output });
}

function envelope(
  recordId: string,
  capturedAt: string,
  options: Readonly<{ sessionId?: string | null }> = {},
): CaptureEnvelopeV1 {
  const sessionId = options.sessionId === undefined ? `sess-${recordId}` : options.sessionId;
  return {
    schemaVersion: 1,
    recordId,
    capturedAt,
    endpoint: "/v1/responses",
    requestText: requestBody(sessionId ?? undefined),
    responseText: responseBody(recordId !== "plain"),
  };
}

interface PageJson {
  captureEnabled?: boolean;
  total?: number;
  offset?: number;
  nextOffset?: number | null;
  records?: Array<Record<string, unknown>>;
}

async function getPage(origin: string, path: string): Promise<Response> {
  return fetch(`${origin}${path}`);
}

async function jsonOf(response: Response): Promise<PageJson> {
  return (await response.json()) as PageJson;
}

const INSPECTION_LIST_PATHS = [
  "/api/inspection/day",
  "/api/inspection/tools",
  "/api/inspection/tool-calls",
  "/api/inspection/sessions",
];

describe("Boat inspection — capture never enabled", () => {
  test("every inspection endpoint serves typed empty results with no capture directory", async () => {
    const { origin, service, directory } = await start(NOW);
    const health = (await (await getPage(origin, "/api/health")).json()) as {
      capture?: { enabled?: boolean };
    };
    expect(health.capture).toEqual({ enabled: false });

    for (const path of INSPECTION_LIST_PATHS) {
      const payload = await jsonOf(await getPage(origin, path));
      expect(payload.captureEnabled).toBe(false);
      expect(payload.total).toBe(0);
      expect(payload.records).toEqual([]);
      expect(payload.nextOffset).toBeNull();
    }
    for (const path of [
      "/api/inspection/messages?recordId=missing",
      "/api/inspection/prompt?recordId=missing",
    ]) {
      const payload = await jsonOf(await getPage(origin, path));
      expect(payload.captureEnabled).toBe(false);
      if (path.includes("/prompt")) {
        expect(payload.total).toBeUndefined();
        expect(payload.records).toBeUndefined();
      } else {
        expect(payload.total).toBe(0);
        expect(payload.records).toEqual([]);
      }
    }
    // Inspection reads never created a capture directory on a disabled server.
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(directory, "captures"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.inspectionStats()).toEqual({ assemblies: 0, cacheHits: 0 });
  });

  test("a disabled server ignores capture files present on disk", async () => {
    const handle = await start(NOW);
    await writeCapture(handle.directory, envelope("ignored", "2026-08-20T10:00:00.000Z"));
    for (const path of INSPECTION_LIST_PATHS) {
      const payload = await jsonOf(await getPage(handle.origin, path));
      expect(payload.total).toBe(0);
      expect(payload.records).toEqual([]);
    }
  });
});

describe("Boat inspection — enabled with fixtures", () => {
  async function startWithFixtures(): Promise<{
    service: LiveUsageService;
    origin: string;
    directory: string;
  }> {
    return start(
      NOW,
      async (directory) => {
        await writeCapture(directory, envelope("a", "2026-08-19T12:00:00.000Z"));
        await writeCapture(directory, envelope("b", "2026-08-20T09:30:00.000Z"));
        await writeCapture(directory, envelope("c", "2026-08-20T10:15:00.000Z"));
        // No derivable session attributes: groups under its own recordId.
        await writeCapture(
          directory,
          envelope("plain", "2026-08-20T11:00:00.000Z", { sessionId: null }),
        );
      },
      { captureEnabled: true },
    );
  }

  test("context day inspection assembles summaries and paginates per report day", async () => {
    const { origin, service } = await startWithFixtures();

    const firstPage = await jsonOf(
      await getPage(origin, "/api/inspection/day?date=2026-08-20&limit=2&offset=0"),
    );
    expect(firstPage.captureEnabled).toBe(true);
    expect(firstPage.total).toBe(3);
    expect(firstPage.nextOffset).toBe(2);
    expect((firstPage.records ?? []).map((record) => record.recordId)).toEqual(["b", "c"]);
    expect(firstPage.records?.[0]).toMatchObject({
      model: "gpt-5",
      messageCount: 2,
      instructionsPresent: true,
      toolCount: 1,
      toolCallCount: 1,
      sessionId: "sess-b",
    });

    const secondPage = await jsonOf(
      await getPage(origin, "/api/inspection/day?date=2026-08-20&limit=2&offset=2"),
    );
    expect((secondPage.records ?? []).map((record) => record.recordId)).toEqual(["plain"]);
    expect(secondPage.nextOffset).toBeNull();

    // The prior report day is addressable and empty rather than an error.
    const otherDay = await jsonOf(await getPage(origin, "/api/inspection/day?date=2026-08-18"));
    expect(otherDay.total).toBe(0);

    // Memoized assembly: repeated requests hit the cache, not the parser.
    const statsBefore = service.inspectionStats();
    await jsonOf(await getPage(origin, "/api/inspection/day?date=2026-08-20"));
    expect(service.inspectionStats().cacheHits).toBeGreaterThan(statsBefore.cacheHits);
  });

  test("memoized day inspection invalidates on capture change and retention deletion", async () => {
    const { origin, service, directory } = await startWithFixtures();
    const before = await jsonOf(await getPage(origin, "/api/inspection/day?date=2026-08-20"));
    expect(before.total).toBe(3);

    // A new capture changes the signature and the assembly result.
    await writeCapture(directory, envelope("d", "2026-08-20T12:00:00.000Z"));
    const afterWrite = await jsonOf(await getPage(origin, "/api/inspection/day?date=2026-08-20"));
    expect(afterWrite.total).toBe(4);

    // Retention deletion bumps the epoch and shrinks the view again.
    await rm(join(directory, "captures", "2026-08-20T12:00:00.000Z_d.capture.json"));
    await service.maintainCaptures();
    const afterDelete = await jsonOf(await getPage(origin, "/api/inspection/day?date=2026-08-20"));
    expect(afterDelete.total).toBe(3);
  });

  test("message inspection merges request and response turns with pagination", async () => {
    const { origin } = await startWithFixtures();
    const firstPage = await jsonOf(
      await getPage(origin, "/api/inspection/messages?recordId=a&limit=2&offset=0"),
    );
    expect(firstPage.total).toBe(3); // two request turns + one response message
    expect(firstPage.records?.[0]).toMatchObject({
      recordId: "a",
      role: "user",
      text: "hello there",
    });

    const secondPage = await jsonOf(
      await getPage(origin, "/api/inspection/messages?recordId=a&limit=2&offset=2"),
    );
    expect(secondPage.records).toHaveLength(1);
    expect(secondPage.records?.[0]).toMatchObject({ role: "assistant", text: "sunny" });
    expect(secondPage.nextOffset).toBeNull();

    const missing = await getPage(origin, "/api/inspection/messages?recordId=absent");
    expect(missing.status).toBe(404);
  });

  test("prompt analysis reports shape without exposing body text", async () => {
    const { origin } = await startWithFixtures();
    const payload = (await (
      await getPage(origin, "/api/inspection/prompt?recordId=b")
    ).json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      captureEnabled: true,
      parsed: true,
      model: "gpt-5",
      instructionsPresent: true,
      inputMessageCount: 2,
      toolCount: 1,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized.includes("hello there")).toBe(false);
    expect(serialized.includes("Be terse.")).toBe(false);
  });

  test("tool schemas and tool calls list across captures with pagination and filters", async () => {
    const { origin } = await startWithFixtures();

    const tools = await jsonOf(await getPage(origin, "/api/inspection/tools?limit=2&offset=0"));
    expect(tools.total).toBe(4); // one function schema per fixture capture
    expect(tools.nextOffset).toBe(2);
    expect(tools.records?.[0]).toMatchObject({
      name: "get_weather",
      type: "function",
      description: "Weather lookup",
    });

    const filtered = await jsonOf(await getPage(origin, "/api/inspection/tools?recordId=c"));
    expect(filtered.total).toBe(1);

    const calls = await jsonOf(await getPage(origin, "/api/inspection/tool-calls?limit=2"));
    expect(calls.total).toBe(3); // every fixture except "plain" produced a call
    expect(calls.records?.[0]).toMatchObject({
      callId: "call_1",
      name: "get_weather",
      argumentsText: '{"city":"Paris"}',
    });
    expect(JSON.stringify(calls)).not.toContain('"text"');
  });

  test("session grouping prefers derived identifiers and falls back to recordId", async () => {
    const { origin } = await startWithFixtures();
    const sessions = await jsonOf(await getPage(origin, "/api/inspection/sessions?limit=10"));
    // sess-a plus three single-capture sessions for b, c, plain.
    expect(sessions.total).toBe(4);
    const records = sessions.records ?? [];
    expect(records.map((group) => group.sessionId)).toContain("sess-a");
    expect(records.find((group) => group.sessionId === "plain")?.recordIds).toEqual(["plain"]);
    // Newest activity sorts first.
    expect(records[0]?.sessionId).toBe("plain");
  });

  test("rejects invalid queries without leaking internals", async () => {
    const { origin } = await startWithFixtures();
    for (const path of [
      "/api/inspection/day?date=tomorrow",
      "/api/inspection/day?limit=0",
      "/api/inspection/tools?limit=999",
      "/api/inspection/sessions?offset=-1",
      "/api/inspection/messages",
      "/api/inspection/prompt",
    ]) {
      const response = await getPage(origin, path);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_query" });
    }
    expect((await getPage(origin, "/api/inspection/nope")).status).toBe(404);
  });

  test("prompt mix decomposes a report day into cohorts without body text", async () => {
    const { origin } = await startWithFixtures();
    const payload = (await (
      await getPage(origin, "/api/inspection/prompt-mix?date=2026-08-20")
    ).json()) as Record<string, unknown>;
    expect(payload.captureEnabled).toBe(true);
    expect(payload.date).toBe("2026-08-20");
    // Every fixture shares one instructions cohort ("Be terse.").
    expect(payload.requests).toBe(3);
    expect(payload.identifiedShare).toBe(1);
    const cohorts = payload.cohorts as Array<Record<string, unknown>>;
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toMatchObject({ identified: true, requests: 3 });
    const serialized = JSON.stringify(payload);
    expect(serialized.includes("Be terse.")).toBe(false);
  });

  test("prompt listings support hash drill-down and section lookups", async () => {
    const { origin, directory } = await startWithFixtures();
    // One capture with distinct instructions so a hash filter can discriminate.
    const distinct: CaptureEnvelopeV1 = {
      ...envelope("z", "2026-08-20T13:00:00.000Z"),
      requestText: JSON.stringify({
        model: "gpt-5-mini",
        instructions: "Answer exhaustively.",
        input: [{ role: "user", type: "message", content: "why" }],
      }),
    };
    await writeCapture(directory, distinct);
    await getPage(origin, "/api/inspection/prompts?date=2026-08-20"); // populate memo
    const list = (await (
      await getPage(origin, "/api/inspection/prompts?date=2026-08-20")
    ).json()) as {
      total: number;
      records?: Array<Record<string, unknown>>;
    };
    expect(list.total).toBe(4);
    const terseHash = list.records?.find((entry) => entry.recordId === "b")?.instructionsHash as
      | string
      | null;
    expect(terseHash).toMatch(/^[0-9a-f]{16}$/);

    const filtered = (await (
      await getPage(origin, `/api/inspection/prompts?date=2026-08-20&hash=${terseHash}`)
    ).json()) as { total: number; records?: Array<Record<string, unknown>> };
    expect(filtered.total).toBe(3); // b, c, plain share the terse instructions
    expect(filtered.records?.every((entry) => entry.instructionsHash === terseHash)).toBe(true);

    const sections = (await (
      await getPage(origin, "/api/inspection/prompt-sections?recordId=b")
    ).json()) as Record<string, unknown>;
    expect(sections.instructionsHash).toBe(terseHash);
    expect(sections.sections).toEqual([
      { kind: "instructions", index: null, role: null, itemType: null, chars: 9 },
      { kind: "message", index: 0, role: "user", itemType: "message", chars: 11 },
      { kind: "message", index: 1, role: "assistant", itemType: null, chars: 12 },
    ]);
    expect(JSON.stringify(sections)).not.toContain("hello there");

    expect((await getPage(origin, "/api/inspection/prompt-sections")).status).toBe(400);
    expect((await getPage(origin, "/api/inspection/prompt-sections?recordId=absent")).status).toBe(
      404,
    );
  });
});
