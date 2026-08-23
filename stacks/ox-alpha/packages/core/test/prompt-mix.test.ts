import { describe, expect, test } from "vitest";
import type { CaptureRequestInspection } from "../src/inspection.ts";
import { buildPromptMix, promptHash, promptSections } from "../src/prompt-mix.ts";

function inspection(overrides: Partial<CaptureRequestInspection> = {}): CaptureRequestInspection {
  return {
    parsed: true,
    model: overrides.model ?? "gpt-5",
    instructions: "instructions" in overrides ? (overrides.instructions ?? null) : "Be terse.",
    sessionId: overrides.sessionId ?? "s1",
    messages: overrides.messages ?? [
      { role: "user", itemType: "message", text: "hello there" },
      { role: "assistant", itemType: "message", text: "hi" },
    ],
    tools: overrides.tools ?? [],
  };
}

describe("prompt mix", () => {
  test("hashes instructions deterministically", () => {
    expect(promptHash("Be terse.")).toBe(promptHash("Be terse."));
    expect(promptHash("Be terse.")).not.toBe(promptHash("Be verbose."));
    expect(promptHash("")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("decomposes a day into hash cohorts with shares and contributions", () => {
    const mix = buildPromptMix("2026-08-20", [
      { model: "gpt-5", instructions: "alpha", promptChars: 100 },
      { model: "gpt-5", instructions: "alpha", promptChars: 200 },
      { model: "gpt-5-mini", instructions: "beta", promptChars: 600 },
      { model: null, instructions: null, promptChars: 300 },
    ]);
    expect(mix.date).toBe("2026-08-20");
    expect(mix.requests).toBe(4);
    expect(mix.meanChars).toBe(300);
    expect(mix.medianChars).toBe(250);
    expect(mix.identifiedShare).toBeCloseTo(0.75, 6);

    // Largest contribution first; the band fallback is unidentified.
    const [beta, alpha, fallback] = mix.cohorts;
    expect(beta).toMatchObject({ identified: true, requests: 1, totalChars: 600 });
    expect(beta?.models).toEqual(["gpt-5-mini"]);
    expect(beta?.contribution).toBeCloseTo(0.25 * 600, 6);
    expect(alpha).toMatchObject({ identified: true, requests: 2, totalChars: 300 });
    expect(alpha?.key).toBe(promptHash("alpha"));
    expect(alpha?.models).toEqual(["gpt-5"]);
    expect(alpha?.contribution).toBeCloseTo(0.5 * 150, 6);
    expect(fallback).toMatchObject({ identified: false, key: "band:<1 KB", requests: 1 });

    const empty = buildPromptMix("2026-08-21", []);
    expect(empty.requests).toBe(0);
    expect(empty.cohorts).toEqual([]);
    expect(empty.meanChars).toBe(0);
  });

  test("sections split instructions from input messages without exposing text", () => {
    const sections = promptSections(
      inspection({
        messages: [
          { role: "user", itemType: "message", text: "hello" },
          { role: "assistant", itemType: "message", text: "hi there" },
        ],
      }),
    );
    expect(sections).toEqual([
      { kind: "instructions", index: null, role: null, itemType: null, chars: 9 },
      { kind: "message", index: 0, role: "user", itemType: "message", chars: 5 },
      { kind: "message", index: 1, role: "assistant", itemType: "message", chars: 8 },
    ]);

    const bare = promptSections(inspection({ instructions: null, messages: [] }));
    expect(bare).toEqual([]);
  });
});
