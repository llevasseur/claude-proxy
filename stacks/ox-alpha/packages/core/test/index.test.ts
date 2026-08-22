import { describe, expect, it } from "vitest";
import { CORE_PACKAGE, sumTokens } from "../src/index.ts";

describe("sumTokens", () => {
  it("adds usage counts", () => {
    expect(sumTokens([1, 2, 3])).toBe(6);
  });

  it("returns zero for empty input", () => {
    expect(sumTokens([])).toBe(0);
  });
});

describe("CORE_PACKAGE", () => {
  it("names the core package", () => {
    expect(CORE_PACKAGE).toBe("@ox-alpha-proxy/core");
  });
});
