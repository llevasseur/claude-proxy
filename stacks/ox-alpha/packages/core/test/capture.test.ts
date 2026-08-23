import { describe, expect, test } from "vitest";
import { parseCaptureEnvelope } from "../src/capture.ts";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordId: "0b9e6c1e-5f2a-4a3b-9c8d-112233445566",
    capturedAt: "2026-08-22T12:00:00.000Z",
    endpoint: "/v1/responses",
    requestText: '{"model":"gpt-5"}',
    responseText: "[redacted]",
    ...overrides,
  };
}

describe("capture envelope v1", () => {
  test("accepts a well-formed envelope and freezes the result", () => {
    const parsed = parseCaptureEnvelope(envelope());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.endpoint).toBe("/v1/responses");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("allows empty body text for exchanges without payload", () => {
    const parsed = parseCaptureEnvelope(envelope({ requestText: "", responseText: "" }));
    expect(parsed.requestText).toBe("");
  });

  test("rejects unknown fields so the schema cannot drift", () => {
    expect(() => parseCaptureEnvelope(envelope({ model: "gpt-5" }))).toThrow(/unknown field model/);
  });

  test("rejects missing fields", () => {
    const partial = envelope();
    delete (partial as Record<string, unknown>).responseText;
    expect(() => parseCaptureEnvelope(partial)).toThrow(/missing field responseText/);
  });

  test("rejects unsupported schema versions", () => {
    expect(() => parseCaptureEnvelope(envelope({ schemaVersion: 2 }))).toThrow(
      /schemaVersion is unsupported/,
    );
  });

  test("rejects non-UTC timestamps and non-path endpoints", () => {
    expect(() => parseCaptureEnvelope(envelope({ capturedAt: "2026-08-22 12:00:00" }))).toThrow(
      /capturedAt/,
    );
    expect(() => parseCaptureEnvelope(envelope({ endpoint: "v1/responses" }))).toThrow(
      /endpoint must start with/,
    );
  });
});
