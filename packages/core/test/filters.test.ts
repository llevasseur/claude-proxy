import { describe, expect, it } from "vitest";
import { PROXY_FILTER_INVENTORY } from "../src/filters.js";

describe("PROXY_FILTER_INVENTORY", () => {
  it("gives every entry a unique id", () => {
    const ids = PROXY_FILTER_INVENTORY.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fully describes every entry for the dashboard", () => {
    for (const f of PROXY_FILTER_INVENTORY) {
      expect(["withheld-tool", "injected-reminder", "refused-tool-use"]).toContain(f.kind);
      for (const field of ["id", "label", "reason", "mechanism"] as const) {
        expect(f[field].length).toBeGreaterThan(0);
      }
    }
  });

  it("covers every mechanism the proxy applies", () => {
    const kinds = new Set(PROXY_FILTER_INVENTORY.map((f) => f.kind));
    expect(kinds.has("withheld-tool")).toBe(true);
    expect(kinds.has("injected-reminder")).toBe(true);
    expect(kinds.has("refused-tool-use")).toBe(true);
  });

  it("documents the filters that require the proxy today", () => {
    const ids = PROXY_FILTER_INVENTORY.map((f) => f.id);
    expect(ids).toContain("EndConversation");
    expect(ids).toContain("task-tools");
    expect(ids).toContain("permission-config");
  });
});
