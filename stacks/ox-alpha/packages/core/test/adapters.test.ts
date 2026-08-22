import { describe, expect, it } from "vitest";
import { jsonResponseIdentity, SseResponseObserver } from "../src/adapters.ts";

const completedResponse = {
  object: "response",
  model: "gpt-5",
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens_details: { reasoning_tokens: 20 },
  },
};

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe("jsonResponseIdentity", () => {
  it("selects the usage object from a non-streaming response body", () => {
    const identity = jsonResponseIdentity(JSON.stringify(completedResponse));
    expect(identity).toEqual({
      model: "gpt-5",
      usage: expect.objectContaining({ totalTokens: 150 }),
    });
  });

  it("returns null for non-response objects or malformed bodies", () => {
    expect(jsonResponseIdentity("{}")).toBeNull();
    expect(jsonResponseIdentity("not json")).toBeNull();
    expect(jsonResponseIdentity(JSON.stringify({ object: "response", model: "" }))).toBeNull();
  });

  it("returns null when usage is invalid instead of throwing", () => {
    expect(
      jsonResponseIdentity(
        JSON.stringify({ object: "response", model: "gpt-5", usage: { input_tokens: -1 } }),
      ),
    ).toBeNull();
  });
});

describe("SseResponseObserver", () => {
  it("keeps the final authoritative usage across multiple completed events", () => {
    const observer = new SseResponseObserver();
    observer.push(
      new TextEncoder().encode(
        sseEvent("response.created", { type: "response.created" }) +
          sseEvent("response.completed", {
            type: "response.completed",
            response: { ...completedResponse, model: "gpt-5-mini" },
          }),
      ),
    );
    observer.push(
      new TextEncoder().encode(
        sseEvent("response.completed", {
          type: "response.completed",
          response: completedResponse,
        }),
      ),
    );
    const identity = observer.finish();
    expect(identity?.model).toBe("gpt-5");
    expect(identity?.usage.totalTokens).toBe(150);
  });

  it("accepts events whose type is carried only by the data payload", () => {
    const observer = new SseResponseObserver();
    observer.push(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type: "response.completed", response: completedResponse })}\n\n`,
      ),
    );
    expect(observer.finish()?.model).toBe("gpt-5");
  });

  it("ignores non-completed events, [DONE], and malformed payloads", () => {
    const observer = new SseResponseObserver();
    observer.push(
      new TextEncoder().encode(
        sseEvent("response.output_text.delta", { delta: "hi" }) +
          "data: [DONE]\n\n" +
          sseEvent("response.completed", { broken: true }) +
          "data: {not json}\n\n",
      ),
    );
    expect(observer.finish()).toBeNull();
  });

  it("buffers chunks split across event boundaries and handles CRLF", () => {
    const observer = new SseResponseObserver();
    const text = `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: completedResponse })}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    observer.push(bytes.slice(0, 30));
    observer.push(bytes.slice(30));
    expect(observer.finish()?.usage.totalTokens).toBe(150);
  });
});
