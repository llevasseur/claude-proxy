import { describe, expect, it } from "vitest";
import { computeSkimDigest, skimDigestsByDay } from "../src/skim.js";
import { priceFor } from "../src/pricing.js";
import { makeSidecar, makeSkim } from "./helpers.js";

const hit = (savedInputTokens: number, cacheKey: string, model = "claude-opus-4-8") =>
  makeSidecar({ model, skim: makeSkim({ enabled: true, servedFromCache: true, savedInputTokens, cacheKey }) });

const miss = (cacheKey: string | null = null) =>
  makeSidecar({ skim: makeSkim({ enabled: true, servedFromCache: false, cacheKey }) });

describe("computeSkimDigest", () => {
  it("returns a well-formed empty digest for no input", () => {
    const d = computeSkimDigest([], { date: "2026-07-15" });
    expect(d.requestCount).toBe(0);
    expect(d.enabledRequests).toBe(0);
    expect(d.hits).toBe(0);
    expect(d.misses).toBe(0);
    expect(d.hitRate).toBe(0);
    expect(d.savedInputTokens).toBe(0);
    expect(d.estSavedUsd).toBe(0);
    expect(d.topShapes).toEqual([]);
  });

  it("counts hits, misses and hit-rate over enabled traffic only", () => {
    const d = computeSkimDigest([hit(1_000, "a"), hit(2_000, "a"), miss("a"), miss("b")], { date: "2026-07-15" });
    expect(d.hits).toBe(2);
    expect(d.misses).toBe(2);
    expect(d.enabledRequests).toBe(4);
    expect(d.hitRate).toBeCloseTo(0.5);
    expect(d.savedInputTokens).toBe(3_000);
  });

  it("excludes skim-disabled requests from the denominator", () => {
    const d = computeSkimDigest([makeSidecar(), hit(500, "k")], { date: "2026-07-15" });
    expect(d.requestCount).toBe(2);
    expect(d.enabledRequests).toBe(1);
    expect(d.hits).toBe(1);
    expect(d.hitRate).toBe(1);
  });

  it("estimates dollars saved at the model's input rate", () => {
    const d = computeSkimDigest([hit(1_000_000, "a", "claude-opus-4-8")], { date: "2026-07-15" });
    expect(d.estSavedUsd).toBeCloseTo(priceFor("claude-opus-4-8").input);
  });

  it("ranks top repeated request shapes by request count", () => {
    const d = computeSkimDigest([hit(100, "hot"), hit(100, "hot"), miss("hot"), hit(100, "cold")], {
      date: "2026-07-15",
    });
    expect(d.topShapes[0]!.cacheKey).toBe("hot");
    expect(d.topShapes[0]!.requests).toBe(3);
    expect(d.topShapes[0]!.hits).toBe(2);
    expect(d.topShapes[1]!.cacheKey).toBe("cold");
  });

  it("retains request text for each shape when the server enriches a sidecar", () => {
    const sidecar = hit(100, "hot") as ReturnType<typeof hit> & { skimRequestText: string };
    sidecar.skimRequestText = "Show me the cached result";
    const d = computeSkimDigest([sidecar], { date: "2026-07-15" });
    expect(d.topShapes[0]!.requestText).toBe("Show me the cached result");
  });

  it("honours topN", () => {
    const sidecars = ["a", "b", "c"].map((k) => hit(100, k));
    const d = computeSkimDigest(sidecars, { date: "2026-07-15", topN: 2 });
    expect(d.topShapes).toHaveLength(2);
  });

  it("skips malformed sidecars", () => {
    const d = computeSkimDigest([hit(100, "a"), { nope: true }, null, "garbage"], { date: "2026-07-15" });
    expect(d.requestCount).toBe(1);
    expect(d.hits).toBe(1);
  });
});

describe("skimDigestsByDay", () => {
  it("splits by UTC day, oldest first", () => {
    const d1 = makeSidecar({ timestamp: "2026-07-14T10:00:00.000Z", skim: makeSkim({ enabled: true, servedFromCache: true, savedInputTokens: 100, cacheKey: "a" }) });
    const d2 = makeSidecar({ timestamp: "2026-07-15T10:00:00.000Z", skim: makeSkim({ enabled: true, servedFromCache: false, cacheKey: "b" }) });
    const digests = skimDigestsByDay([d2, d1]);
    expect(digests.map((d) => d.date)).toEqual(["2026-07-14", "2026-07-15"]);
    expect(digests[0]!.hits).toBe(1);
    expect(digests[1]!.misses).toBe(1);
  });
});
