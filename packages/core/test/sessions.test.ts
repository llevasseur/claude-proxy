import { describe, expect, it } from "vitest";
import { parseSessionTranscript } from "../src/sessions.js";

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
