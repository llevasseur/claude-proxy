import { describe, expect, it } from "vitest";
import { diffWirePrompts, outlineWirePrompt, PREAMBLE, sectionsOfText } from "../src/wire-prompt.js";

const block = (text: string, ttl?: string) => ({
  type: "text",
  text,
  ...(ttl ? { cache_control: { type: "ephemeral", ttl } } : {}),
});

describe("outlineWirePrompt", () => {
  it("reports zero for an absent system field", () => {
    expect(outlineWirePrompt(undefined)).toEqual({ bytes: 0, blocks: [], sections: [] });
    expect(outlineWirePrompt(null)).toEqual({ bytes: 0, blocks: [], sections: [] });
  });

  it("counts the same bytes the proxy records as systemBytes", () => {
    const system = [block("# One\nhello"), block("# Two\nworld")];
    expect(outlineWirePrompt(system).bytes).toBe(Buffer.byteLength(JSON.stringify(system)));
  });

  it("treats a bare string as a single block", () => {
    const outline = outlineWirePrompt("# Only\nbody");
    expect(outline.blocks).toHaveLength(1);
    expect(outline.sections.map((s) => s.heading)).toEqual(["Only"]);
  });

  it("splits each block into heading spans that sum to its text bytes", () => {
    const outline = outlineWirePrompt([block("intro\n# A\naaa\n## B\nbbb")]);
    expect(outline.sections.map((s) => [s.heading, s.level])).toEqual([
      [PREAMBLE, 0],
      ["A", 1],
      ["B", 2],
    ]);
    const summed = outline.sections.reduce((a, s) => a + s.bytes, 0);
    expect(summed).toBe(outline.blocks[0]!.textBytes);
  });

  it("ignores headings inside fenced code", () => {
    const outline = outlineWirePrompt([block("# Real\n```sh\n# not a heading\n```\n# Also real")]);
    expect(outline.sections.map((s) => s.heading)).toEqual(["Real", "Also real"]);
  });

  it("records cache ttl per block", () => {
    const outline = outlineWirePrompt([block("a", "1h"), block("b")]);
    expect(outline.blocks.map((b) => b.cacheTtl)).toEqual(["1h", null]);
  });

  it("counts multi-byte characters as their utf-8 length", () => {
    const [section] = sectionsOfText("# Héllo — ok", 0);
    expect(section!.bytes).toBe(Buffer.byteLength("# Héllo — ok"));
  });
});

describe("diffWirePrompts", () => {
  it("labels added, removed, and resized sections, biggest move first", () => {
    const prior = outlineWirePrompt([block("# Keep\nsame\n# Shrink\nlots and lots of text here\n# Gone\nbye")]);
    const current = outlineWirePrompt([block("# Keep\nsame\n# Shrink\ntiny\n# New\nhello")]);

    const moves = diffWirePrompts(prior, current);
    const byHeading = Object.fromEntries(moves.map((m) => [m.heading, m.status]));
    expect(byHeading).toMatchObject({ Keep: "same", Shrink: "shrank", Gone: "removed", New: "added" });
    expect(Math.abs(moves[0]!.deltaBytes)).toBeGreaterThanOrEqual(Math.abs(moves[1]!.deltaBytes));
  });

  it("sums a heading repeated across blocks into one row", () => {
    const outline = outlineWirePrompt([block("# Tools\nabc"), block("# Tools\ndef")]);
    const moves = diffWirePrompts({ sections: [] }, outline);
    expect(moves.filter((m) => m.heading === "Tools")).toHaveLength(1);
  });
});
