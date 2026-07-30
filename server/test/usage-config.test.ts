import { describe, expect, it } from "vitest";
import { parseLimit, resolveUsageLimits } from "../src/usage-config.js";

describe("parseLimit", () => {
  it("accepts plain, separated, and suffixed magnitudes", () => {
    expect(parseLimit("2500000")).toBe(2_500_000);
    expect(parseLimit("2_500_000")).toBe(2_500_000);
    expect(parseLimit("2.5m")).toBe(2_500_000);
    expect(parseLimit("900k")).toBe(900_000);
    expect(parseLimit(" 900K ")).toBe(900_000);
  });

  it("rejects anything that isn't a positive number", () => {
    expect(parseLimit(undefined)).toBeNull();
    expect(parseLimit("")).toBeNull();
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("-5")).toBeNull();
    expect(parseLimit("lots")).toBeNull();
    expect(parseLimit("5gb")).toBeNull();
  });
});

describe("resolveUsageLimits", () => {
  it("reads each window's ceiling and leaves unset ones absent", () => {
    expect(resolveUsageLimits({ USAGE_LIMIT_5H: "1m", USAGE_LIMIT_WEEK: "10m" })).toEqual({
      "5h": 1_000_000,
      week: 10_000_000,
    });
  });

  it("is empty when nothing is configured, so no window is invented", () => {
    expect(resolveUsageLimits({})).toEqual({});
  });

  it("drops a malformed value rather than defaulting it", () => {
    expect(resolveUsageLimits({ USAGE_LIMIT_5H: "nope", USAGE_LIMIT_WEEK_FABLE: "250k" })).toEqual({
      weekFable: 250_000,
    });
  });
});
