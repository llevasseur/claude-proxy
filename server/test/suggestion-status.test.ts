// The flags outlive the process, so what matters here is the file: where it lands,
// that a missing or corrupt one reads as "nothing decided yet", and that a write
// round-trips through it.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSuggestionStatusStore,
  resolveSuggestionStatusPath,
  updateSuggestionStatusStore,
  writeSuggestionStatusStore,
} from "../src/suggestion-status.js";

const logDir = () => mkdtemp(path.join(tmpdir(), "suggestion-status-"));

describe("suggestion status file", () => {
  it("sits beside the logs it describes", async () => {
    expect(resolveSuggestionStatusPath("/logs")).toBe(path.join("/logs", "suggestion-status.json"));
  });

  it("reads a missing file as nothing decided yet", async () => {
    expect((await readSuggestionStatusStore(path.join(await logDir(), "nope"))).buckets).toEqual({});
  });

  it("reads a corrupt file as empty rather than throwing", async () => {
    const dir = await logDir();
    await writeFile(resolveSuggestionStatusPath(dir), "{ not json", "utf8");
    expect((await readSuggestionStatusStore(dir)).buckets).toEqual({});
  });

  it("round-trips a flag through the file", async () => {
    const dir = await logDir();
    const written = await updateSuggestionStatusStore(dir, [{ bucket: 9, id: "serial-discovery", status: "done", note: "PR #71" }]);
    expect(written.buckets["9"]?.["serial-discovery"]?.status).toBe("done");

    const reread = await readSuggestionStatusStore(dir);
    expect(reread.buckets["9"]?.["serial-discovery"]).toMatchObject({ status: "done", note: "PR #71" });
  });

  it("merges into what is already recorded instead of replacing it", async () => {
    const dir = await logDir();
    await updateSuggestionStatusStore(dir, [{ bucket: 1, id: "a", status: "done" }]);
    await updateSuggestionStatusStore(dir, [{ bucket: 2, id: "b", status: "skipped" }]);
    const store = await readSuggestionStatusStore(dir);
    expect(Object.keys(store.buckets).sort()).toEqual(["1", "2"]);
  });

  it("writes readable JSON, not a one-line blob", async () => {
    const dir = await logDir();
    await writeSuggestionStatusStore(dir, { version: 1, buckets: { "1": { a: { status: "done", updated: "2026-07-26T00:00:00.000Z" } } } });
    const text = await readFile(resolveSuggestionStatusPath(dir), "utf8");
    expect(text.split("\n").length).toBeGreaterThan(3);
    expect(text.endsWith("\n")).toBe(true);
  });
});
