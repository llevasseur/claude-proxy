import { describe, expect, it } from "vitest";
import {
  classifyDenyRules,
  isGlobRule,
  isScopedRule,
  matchesRule,
  withheldReport,
} from "../src/withheld.js";
import { makeSidecar } from "./helpers.js";

describe("rule classification", () => {
  it("treats bare names and bare-name globs as schema-stripping", () => {
    expect(isScopedRule("Artifact")).toBe(false);
    expect(isScopedRule("mcp__*")).toBe(false);
    expect(isScopedRule("Bash(rm *)")).toBe(true);
    expect(isGlobRule("mcp__claude_ai_Linear__*")).toBe(true);
    expect(isGlobRule("Artifact")).toBe(false);
  });

  it("splits a deny array into schema-stripping vs scoped", () => {
    const c = classifyDenyRules(["Artifact", "mcp__*", "Bash(rm *)", "WebFetch(domain:x.com)"]);
    expect(c.schemaStripping).toEqual(["Artifact", "mcp__*"]);
    expect(c.scoped).toEqual(["Bash(rm *)", "WebFetch(domain:x.com)"]);
  });

  it("ignores empty / non-string rules", () => {
    const c = classifyDenyRules(["Artifact", "", null as unknown as string]);
    expect(c.schemaStripping).toEqual(["Artifact"]);
    expect(c.scoped).toEqual([]);
  });
});

describe("matchesRule", () => {
  it("matches exact bare names", () => {
    expect(matchesRule("Artifact", "Artifact")).toBe(true);
    expect(matchesRule("Artifact", "Artifactory")).toBe(false);
  });

  it("matches glob rules anchored to the full name", () => {
    expect(matchesRule("mcp__*", "mcp__claude_ai_Linear__authenticate")).toBe(true);
    expect(matchesRule("mcp__claude_ai_Linear__*", "mcp__claude_ai_Linear__authenticate")).toBe(true);
    expect(matchesRule("mcp__claude_ai_Linear__*", "mcp__claude_ai_Sentry__authenticate")).toBe(false);
    expect(matchesRule("mcp__*", "Bash")).toBe(false);
  });
});

describe("withheldReport", () => {
  const deny = ["Artifact", "mcp__claude_ai_Linear__authenticate", "Bash(rm *)"];

  it("reports schema-stripping rules and separates scoped ones", () => {
    const r = withheldReport([], deny);
    expect(r.rules.map((x) => x.rule)).toEqual(["Artifact", "mcp__claude_ai_Linear__authenticate"]);
    expect(r.scopedRules).toEqual(["Bash(rm *)"]);
    expect(r.rulesStillLeaking).toBe(0);
  });

  it("flags a withheld tool that still appears in sampled requests", () => {
    const s = makeSidecar({
      timestamp: "2026-07-16T10:00:00.000Z",
      tools: [
        { name: "Artifact", bytes: 5_000, estTokens: 1_250 },
        { name: "Bash", bytes: 4_000, estTokens: 1_000 },
      ],
    });
    const r = withheldReport([s], deny);
    const artifact = r.rules.find((x) => x.rule === "Artifact")!;
    expect(artifact.stillPresent).toHaveLength(1);
    expect(artifact.stillPresent[0]).toMatchObject({ name: "Artifact", occurrences: 1, lastSeen: "2026-07-16T10:00:00.000Z" });
    expect(r.rulesStillLeaking).toBe(1);
    expect(r.observedToolCount).toBe(2);
    expect(r.requestsSampled).toBe(1);
  });

  it("is healthy (nothing leaking) when withheld tools are absent from traffic", () => {
    const s = makeSidecar({ tools: [{ name: "Bash", bytes: 4_000, estTokens: 1_000 }] });
    const r = withheldReport([s], deny);
    expect(r.rulesStillLeaking).toBe(0);
    expect(r.rules.every((x) => x.stillPresent.length === 0)).toBe(true);
  });

  it("aggregates occurrences and keeps the latest lastSeen across requests", () => {
    const a = makeSidecar({ timestamp: "2026-07-16T09:00:00.000Z", tools: [{ name: "Artifact", bytes: 5_000, estTokens: 1_250 }] });
    const b = makeSidecar({ timestamp: "2026-07-16T11:00:00.000Z", tools: [{ name: "Artifact", bytes: 5_000, estTokens: 1_250 }] });
    const r = withheldReport([a, b], deny);
    const artifact = r.rules.find((x) => x.rule === "Artifact")!;
    expect(artifact.stillPresent[0]).toMatchObject({ occurrences: 2, lastSeen: "2026-07-16T11:00:00.000Z", estTokens: 2_500 });
  });

  it("skips malformed sidecars", () => {
    const r = withheldReport([makeSidecar(), { nope: true }, null], deny);
    expect(r.requestsSampled).toBe(1);
  });
});
