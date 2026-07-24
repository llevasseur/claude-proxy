import { describe, expect, it } from "vitest";
import { parseSessionErrors, parseSessionNodes, parseSessionTranscript } from "../src/sessions.js";

const TRANSCRIPT = [
  "",
  "# Session ab3167129339d34f",
  "- model: claude-opus-4-8",
  "- session: be4b71b3-ccaf-4350-b1aa-b0cf0218897a",
  "- started: 2026-07-23T17:40:51.064Z",
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
  });

  it("leaves fields null when the header is missing and counts nothing", () => {
    const m = parseSessionTranscript("deadbeefdeadbeef", "just some text\nno structure");
    expect(m.model).toBeNull();
    expect(m.sessionId).toBeNull();
    expect(m.started).toBeNull();
    expect(m.firstTask).toBeNull();
    expect(m).toMatchObject({ tasks: 0, decisions: 0, tools: 0, errors: 0 });
  });

  it("handles CRLF line endings", () => {
    const m = parseSessionTranscript("ab3167129339d34f", TRANSCRIPT.replace(/\n/g, "\r\n"));
    expect(m.model).toBe("claude-opus-4-8");
    expect(m.tools).toBe(3);
    expect(m.firstTask).toBe("Fix the login bug");
  });
});

describe("parseSessionNodes", () => {
  it("streams the appended lines in order, typed and carrying task/tool context", () => {
    const nodes = parseSessionNodes(TRANSCRIPT);
    expect(nodes).toEqual([
      { index: 0, type: "task", text: "Fix the login bug", tool: null, task: "Fix the login bug" },
      { index: 1, type: "decision", text: "Reading the handler first.", tool: null, task: "Fix the login bug" },
      { index: 2, type: "tool", text: "Read(file_path=/auth.ts)", tool: "Read(file_path=/auth.ts)", task: "Fix the login bug" },
      { index: 3, type: "tool", text: "Bash(command=npm test)", tool: "Bash(command=npm test)", task: "Fix the login bug" },
      { index: 4, type: "error", text: "ENOENT: no such file", tool: "Bash(command=npm test)", task: "Fix the login bug" },
      { index: 5, type: "done", text: "All tests pass.", tool: null, task: "Fix the login bug" },
      { index: 6, type: "task", text: "Add a follow-up feature", tool: null, task: "Add a follow-up feature" },
      { index: 7, type: "decision", text: "Editing the router.", tool: null, task: "Add a follow-up feature" },
      { index: 8, type: "tool", text: "Edit(file_path=/router.tsx)", tool: "Edit(file_path=/router.tsx)", task: "Add a follow-up feature" },
    ]);
  });

  it("skips the header and returns nothing for unstructured text", () => {
    expect(parseSessionNodes("# Session deadbeefdeadbeef\n- model: x\n\njust prose")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const nodes = parseSessionNodes(TRANSCRIPT.replace(/\n/g, "\r\n"));
    expect(nodes).toHaveLength(9);
    expect(nodes.map((n) => n.type)).toEqual(["task", "decision", "tool", "tool", "error", "done", "task", "decision", "tool"]);
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
