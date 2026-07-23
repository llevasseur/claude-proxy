import { describe, expect, it } from "vitest";
import { parseSessionErrors, parseSessionTranscript } from "../src/sessions.js";

const TRANSCRIPT = [
  "",
  "# Session ab3167129339d34f",
  "- model: claude-opus-4-8",
  "- session: be4b71b3-ccaf-4350-b1aa-b0cf0218897a",
  "- started: 2026-07-23T17:40:51.064Z",
  "- title: Fix the login bug",
  "- subtitle: Fix the login bug so users can sign in",
  "",
  "## Task: Fix the login bug",
  "- decided: Reading the handler first.",
  "- Read(file_path=/auth.ts)",
  "- Bash(command=npm test)",
  "- ✗ ENOENT: no such file",
  "- done: All tests pass.",
  "",
  "## Task: Add a follow-up feature",
  "- decided: Editing the router.",
  "- Edit(file_path=/router.tsx)",
  "",
].join("\n");

describe("parseSessionTranscript", () => {
  it("pulls the header fields and counts turns", () => {
    const m = parseSessionTranscript("ab3167129339d34f", TRANSCRIPT);
    expect(m.threadId).toBe("ab3167129339d34f");
    expect(m.model).toBe("claude-opus-4-8");
    expect(m.sessionId).toBe("be4b71b3-ccaf-4350-b1aa-b0cf0218897a");
    expect(m.started).toBe("2026-07-23T17:40:51.064Z");
    expect(m.tasks).toBe(2);
    expect(m.decisions).toBe(2);
    expect(m.tools).toBe(3); // Read, Bash, Edit — not decided/done/✗ lines
    expect(m.errors).toBe(1);
    expect(m.firstTask).toBe("Fix the login bug");
    expect(m.title).toBe("Fix the login bug");
    expect(m.subtitle).toBe("Fix the login bug so users can sign in");
  });

  it("leaves fields null when the header is missing and counts nothing", () => {
    const m = parseSessionTranscript("deadbeefdeadbeef", "just some text\nno structure");
    expect(m.model).toBeNull();
    expect(m.sessionId).toBeNull();
    expect(m.started).toBeNull();
    expect(m.firstTask).toBeNull();
    expect(m.title).toBeNull();
    expect(m.subtitle).toBeNull();
    expect(m).toMatchObject({ tasks: 0, decisions: 0, tools: 0, errors: 0 });
  });

  it("picks up a title appended after the tasks (the titling request arrives out of band)", () => {
    const transcript = [
      "# Session ab3167129339d34f",
      "- model: claude-opus-4-8",
      "- subtitle: do the thing",
      "",
      "## Task: do the thing",
      "- done: done it.",
      "- title: Do the thing well",
    ].join("\n");
    const m = parseSessionTranscript("ab3167129339d34f", transcript);
    expect(m.title).toBe("Do the thing well");
    expect(m.subtitle).toBe("do the thing");
    expect(m.firstTask).toBe("do the thing");
  });

  it("handles CRLF line endings", () => {
    const m = parseSessionTranscript("ab3167129339d34f", TRANSCRIPT.replace(/\n/g, "\r\n"));
    expect(m.model).toBe("claude-opus-4-8");
    expect(m.tools).toBe(3);
    expect(m.firstTask).toBe("Fix the login bug");
  });
});

describe("parseSessionErrors", () => {
  it("re-links each error to its task and nearest preceding tool call", () => {
    const errors = parseSessionErrors(TRANSCRIPT);
    expect(errors).toEqual([
      { index: 0, task: "Fix the login bug", tool: "Bash(command=npm test)", text: "ENOENT: no such file" },
    ]);
  });

  it("returns an empty list when the transcript records no errors", () => {
    expect(parseSessionErrors("just some text\nno structure")).toEqual([]);
  });

  it("blames a tool call at most once and carries task/tool context per error", () => {
    const transcript = [
      "## Task: Ship it",
      "- Bash(command=npm run build)",
      "- ✗ build failed: exit 1",
      "- ✗ cleanup also failed",
      "## Task: Recover",
      "- ✗ nothing to undo",
    ].join("\n");
    expect(parseSessionErrors(transcript)).toEqual([
      { index: 0, task: "Ship it", tool: "Bash(command=npm run build)", text: "build failed: exit 1" },
      { index: 1, task: "Ship it", tool: null, text: "cleanup also failed" },
      { index: 2, task: "Recover", tool: null, text: "nothing to undo" },
    ]);
  });

  it("handles CRLF line endings", () => {
    const errors = parseSessionErrors(TRANSCRIPT.replace(/\n/g, "\r\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tool: "Bash(command=npm test)", text: "ENOENT: no such file" });
  });
});
