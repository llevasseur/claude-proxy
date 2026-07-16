import { describe, expect, it } from "vitest";
import { computeDigest } from "../src/digest.js";
import { HeuristicAdviceProvider, ADVICE_THRESHOLDS } from "../src/advice.js";
import { makeSidecar } from "./helpers.js";

const provider = new HeuristicAdviceProvider();
const ids = (digestInput: Parameters<typeof computeDigest>[0], date = "2026-07-15") =>
  provider.advise(computeDigest(digestInput, { date })).map((a) => a.id);

describe("HeuristicAdviceProvider", () => {
  it("reports no activity on an empty day", () => {
    expect(ids([])).toEqual(["no-activity"]);
  });

  it("flags a dominant tool", () => {
    const s = makeSidecar({
      tools: [
        { name: "Hog", bytes: 90_000, estTokens: 22_500 },
        { name: "Tiny", bytes: 1_000, estTokens: 250 },
      ],
    });
    expect(ids([s])).toContain("dominant-tool");
  });

  it("flags high tool overhead relative to input", () => {
    // Huge tool tokens vs tiny real input → overhead % well over threshold.
    const s = makeSidecar({
      tokens: { input: 10, output: 10, cacheRead: 90, cacheCreation: 0, realInput: 100 },
      tools: [{ name: "Big", bytes: 400_000, estTokens: 100_000 }],
    });
    expect(ids([s])).toContain("tool-overhead");
  });

  it("flags low cache-hit ratio only with enough traffic", () => {
    const lowCache = makeSidecar({
      tokens: { input: 900, output: 100, cacheRead: 100, cacheCreation: 0, realInput: 1_000 },
      tools: [{ name: "A", bytes: 10, estTokens: 2 }],
    });
    const many = Array.from({ length: ADVICE_THRESHOLDS.minRequestsForCacheAdvice }, () => lowCache);
    expect(ids(many)).toContain("low-cache-hit");
    // A single request (below the traffic floor) should not trip it.
    expect(ids([lowCache])).not.toContain("low-cache-hit");
  });

  it("flags a high estimated daily cost as high severity", () => {
    // Lots of opus output → well over the cost threshold.
    const pricey = makeSidecar({
      tokens: { input: 0, output: 2_000_000, cacheRead: 0, cacheCreation: 0, realInput: 0 },
      tools: [{ name: "A", bytes: 10, estTokens: 2 }],
    });
    const advice = provider.advise(computeDigest([pricey], { date: "2026-07-15" }));
    const high = advice.find((a) => a.id === "high-cost");
    expect(high?.severity).toBe("high");
    // High severity sorts first.
    expect(advice[0]!.severity).toBe("high");
  });

  it("returns a healthy note when nothing trips", () => {
    // Many small, evenly-sized tools → no single tool dominates (<15%),
    // low overhead, high cache hit, small system prompt: nothing trips.
    const tools = Array.from({ length: 8 }, (_, i) => ({ name: `T${i}`, bytes: 20, estTokens: 2 }));
    const clean = makeSidecar({
      tokens: { input: 10, output: 10, cacheRead: 980, cacheCreation: 0, realInput: 1_000 },
      request: { toolCount: tools.length, toolsBytes: 160, systemBytes: 500, totalBytes: 5_000 },
      tools,
    });
    expect(ids([clean])).toEqual(["healthy"]);
  });
});
