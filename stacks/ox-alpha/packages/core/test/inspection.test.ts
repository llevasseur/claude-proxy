import { describe, expect, test } from "vitest";
import { analyzePrompt, inspectCaptureRequest, inspectCaptureResponse } from "../src/inspection.ts";

const REQUEST_JSON = JSON.stringify({
  model: "gpt-5",
  instructions: "Be terse.",
  session_id: "sess-1",
  input: [
    { role: "user", type: "message", content: [{ type: "input_text", text: "hello" }] },
    { role: "assistant", content: "earlier answer" },
    "bare string input",
  ],
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Weather lookup",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
    { type: "web_search" },
  ],
});

describe("inspectCaptureRequest", () => {
  test("parses messages, tools, and session identity", () => {
    const inspection = inspectCaptureRequest(REQUEST_JSON);
    expect(inspection.parsed).toBe(true);
    expect(inspection.model).toBe("gpt-5");
    expect(inspection.instructions).toBe("Be terse.");
    expect(inspection.sessionId).toBe("sess-1");
    expect(inspection.messages.map((message) => message.text)).toEqual([
      "hello",
      "earlier answer",
      "bare string input",
    ]);
    expect(inspection.tools).toHaveLength(2);
    const firstTool = inspection.tools[0];
    expect(firstTool).toMatchObject({
      name: "get_weather",
      type: "function",
      description: "Weather lookup",
    });
    expect(JSON.parse(firstTool?.schemaJson ?? "{}")).toMatchObject({ type: "object" });
    expect(inspection.tools[1]).toMatchObject({
      name: "(built-in web_search)",
      type: "web_search",
    });
  });

  test("derives session from metadata then user", () => {
    expect(
      inspectCaptureRequest(JSON.stringify({ metadata: { session_id: "m-1" } })).sessionId,
    ).toBe("m-1");
    expect(inspectCaptureRequest(JSON.stringify({ user: "u-9" })).sessionId).toBe("u-9");
    expect(inspectCaptureRequest("{}").sessionId).toBeNull();
  });

  test("degrades to a typed unparsed result for non-JSON text", () => {
    const inspection = inspectCaptureRequest("<html>not json</html>");
    expect(inspection.parsed).toBe(false);
    expect(inspection.messages).toEqual([]);
    expect(inspection.tools).toEqual([]);
    expect(inspection.sessionId).toBeNull();
    expect(inspectCaptureRequest("").parsed).toBe(false);
  });
});

describe("inspectCaptureResponse", () => {
  const RESPONSE_JSON = JSON.stringify({
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
    ],
  });

  test("parses output messages and tool calls from JSON", () => {
    const inspection = inspectCaptureResponse(RESPONSE_JSON);
    expect(inspection.parsed).toBe(true);
    expect(inspection.outputMessages.map((message) => message.text)).toEqual(["done"]);
    expect(inspection.toolCalls).toEqual([
      { callId: "call_1", name: "get_weather", argumentsText: '{"city":"Paris"}' },
    ]);
  });

  test("merges tool calls across SSE data frames", () => {
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const sse = `${frame({ output: [] })}${frame({
      output: [{ type: "function_call", call_id: "c2", name: "t" }],
    })}data: [DONE]\n\nevent: junk\n`;
    const inspection = inspectCaptureResponse(sse);
    expect(inspection.parsed).toBe(true);
    expect(inspection.toolCalls).toEqual([{ callId: "c2", name: "t", argumentsText: "" }]);
    expect(inspection.outputMessages).toEqual([]);
  });

  test("degrades to typed empties for unparseable text", () => {
    const inspection = inspectCaptureResponse("nope");
    expect(inspection.parsed).toBe(false);
    expect(inspection.outputMessages).toEqual([]);
    expect(inspection.toolCalls).toEqual([]);
  });
});

describe("analyzePrompt", () => {
  test("summarizes prompt shape with a documented chars-per-token heuristic", () => {
    const analysis = analyzePrompt(inspectCaptureRequest(REQUEST_JSON));
    expect(analysis).toMatchObject({
      parsed: true,
      model: "gpt-5",
      instructionsPresent: true,
      instructionsChars: 9,
      inputMessageCount: 3,
      toolCount: 2,
      estimatedInputTokens: Math.ceil((analysis.inputChars + 9) / 4),
    });
  });

  test("zeros cleanly for an unparsed request", () => {
    expect(analyzePrompt(inspectCaptureRequest(""))).toMatchObject({
      parsed: false,
      inputMessageCount: 0,
      estimatedInputTokens: 0,
    });
  });
});
