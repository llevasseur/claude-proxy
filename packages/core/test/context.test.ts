import { describe, expect, it } from "vitest";
import {
  analyzeRequestBody,
  extractRequestMessage,
  summarizeContext,
  toContextEntry,
  type ContextEntry,
} from "../src/context.js";
import { makeSidecar } from "./helpers.js";

function entry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    file: "2026-07-20T13-31-00-278_anthropic",
    timestamp: "2026-07-20T13:31:00.278Z",
    model: "claude-opus-4-8",
    realInput: 10_000,
    systemBytes: 8_000,
    toolsBytes: 24_000,
    totalBytes: 60_000,
    toolCount: 2,
    ...overrides,
  };
}

describe("summarizeContext", () => {
  it("returns a well-formed empty summary for no input", () => {
    const s = summarizeContext([]);
    expect(s.requestCount).toBe(0);
    expect(s.avgRealInput).toBe(0);
    expect(s.medianRealInput).toBe(0);
    expect(s.maxRealInput).toBe(0);
    expect(s.max).toBeNull();
    expect(s.top).toEqual([]);
  });

  it("computes average, median, and max over several entries", () => {
    const s = summarizeContext([
      entry({ realInput: 10 }),
      entry({ realInput: 20 }),
      entry({ realInput: 60 }),
    ]);
    expect(s.requestCount).toBe(3);
    expect(s.avgRealInput).toBe(30); // (10+20+60)/3
    expect(s.medianRealInput).toBe(20);
    expect(s.maxRealInput).toBe(60);
    expect(s.max?.realInput).toBe(60);
  });

  it("averages the two middle values for an even count", () => {
    const s = summarizeContext([
      entry({ realInput: 10 }),
      entry({ realInput: 20 }),
      entry({ realInput: 30 }),
      entry({ realInput: 50 }),
    ]);
    expect(s.medianRealInput).toBe(25); // round((20+30)/2)
  });

  it("orders top by largest and caps at topN", () => {
    const entries = [100, 500, 300, 200, 400].map((n, i) =>
      entry({ realInput: n, file: `f${i}` }),
    );
    const s = summarizeContext(entries, { topN: 3 });
    expect(s.top.map((e) => e.realInput)).toEqual([500, 400, 300]);
    expect(s.max?.realInput).toBe(500);
  });
});

describe("toContextEntry", () => {
  it("maps a valid sidecar and keeps the file handle", () => {
    const e = toContextEntry(makeSidecar(), "myfile_anthropic");
    expect(e).not.toBeNull();
    expect(e!.file).toBe("myfile_anthropic");
    expect(e!.realInput).toBe(9_100);
    expect(e!.systemBytes).toBe(8_000);
    expect(e!.toolCount).toBe(2);
  });

  it("returns null for a malformed sidecar", () => {
    expect(toContextEntry({ nope: true }, "x")).toBeNull();
  });
});

describe("analyzeRequestBody", () => {
  it("measures system, tools, and messages of a normal body", () => {
    const body = {
      system: [{ type: "text", text: "you are helpful" }],
      tools: [
        { name: "Bash", description: "run shell" },
        { name: "Read", description: "read files" },
      ],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      ],
    };
    const b = analyzeRequestBody(body);
    expect(b.toolCount).toBe(2);
    expect(b.messageCount).toBe(2);
    expect(b.systemBytes).toBeGreaterThan(0);
    expect(b.toolsBytes).toBeGreaterThan(0);
    // Tools are ranked largest-first.
    expect(b.tools[0]!.bytes).toBeGreaterThanOrEqual(b.tools[1]!.bytes);
    expect(b.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(b.messages[0]!.index).toBe(0);
    expect(b.tools.every((t) => t.estTokens === Math.round(t.bytes / 4))).toBe(true);
  });

  it("handles string content and missing names", () => {
    const b = analyzeRequestBody({ tools: [{ description: "x" }], messages: [{ content: "no role" }] });
    expect(b.tools[0]!.name).toBe("(unnamed)");
    expect(b.messages[0]!.role).toBe("unknown");
  });

  it("is tolerant of an empty or malformed body", () => {
    const empty = analyzeRequestBody({});
    expect(empty.toolCount).toBe(0);
    expect(empty.messageCount).toBe(0);
    expect(empty.systemBytes).toBe(0);

    const junk = analyzeRequestBody(null);
    expect(junk.messageCount).toBe(0);
    expect(junk.tools).toEqual([]);
  });
});

describe("extractRequestMessage", () => {
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ],
  };

  it("returns the full message content and size facts by index", () => {
    const m = extractRequestMessage(body, 1);
    expect(m).not.toBeNull();
    expect(m!.index).toBe(1);
    expect(m!.role).toBe("assistant");
    expect(m!.messageCount).toBe(2);
    expect(m!.bytes).toBeGreaterThan(0);
    expect(m!.estTokens).toBe(Math.round(m!.bytes / 4));
    expect(JSON.parse(m!.content)).toEqual(body.messages[1]);
  });

  it("returns null for an out-of-range or non-integer index", () => {
    expect(extractRequestMessage(body, 2)).toBeNull();
    expect(extractRequestMessage(body, -1)).toBeNull();
    expect(extractRequestMessage(body, 0.5)).toBeNull();
  });

  it("defaults role to unknown and tolerates a malformed body", () => {
    expect(extractRequestMessage({ messages: [{ content: "no role" }] }, 0)!.role).toBe("unknown");
    expect(extractRequestMessage({}, 0)).toBeNull();
    expect(extractRequestMessage(null, 0)).toBeNull();
  });
});
