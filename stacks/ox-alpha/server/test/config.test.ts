import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";

// ADR 0050: the listener port is named per stack, the bare name survives as a fallback
// scoped to this package alone, and the default number itself does not move.
describe("readConfig port resolution", () => {
  it("prefers OX_SERVER_PORT over the bare SERVER_PORT", () => {
    expect(readConfig({ OX_SERVER_PORT: "9201", SERVER_PORT: "9202" }).port).toBe(9201);
  });

  it("still resolves the bare SERVER_PORT on its own", () => {
    expect(readConfig({ SERVER_PORT: "9203" }).port).toBe(9203);
  });

  it("defaults to 8788 when neither name is set", () => {
    expect(readConfig({}).port).toBe(8788);
  });

  it("reports whichever name the operator supplied", () => {
    expect(() => readConfig({ OX_SERVER_PORT: "nonsense" })).toThrow(/^OX_SERVER_PORT must be/);
    expect(() => readConfig({ SERVER_PORT: "nonsense" })).toThrow(/^SERVER_PORT must be/);
    expect(() => readConfig({ OX_SERVER_PORT: "70000" })).toThrow(/^OX_SERVER_PORT must be <= 65535/);
  });
});
