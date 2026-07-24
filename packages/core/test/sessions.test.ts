import { describe, expect, it } from "vitest";
import {
  isAgentSpawn,
  linkAgentSessions,
  parseSessionErrors,
  parseSessionNodes,
  parseSessionTranscript,
  spawnAgentType,
  type LinkableSession,
} from "../src/sessions.js";

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

describe("spawnAgentType", () => {
  const nodeFor = (line: string) => parseSessionNodes(line)[0]!;

  it("reads the subagent_type off an Agent/Task call", () => {
    expect(spawnAgentType(nodeFor("- Agent(subagent_type=Explore)"))).toBe("Explore");
    expect(spawnAgentType(nodeFor("- Task(subagent_type=general-purpose)"))).toBe("general-purpose");
  });

  it("reports a spawn with no recorded type as an empty string, not null", () => {
    expect(spawnAgentType(nodeFor("- Agent(description=go look)"))).toBe("");
    expect(isAgentSpawn(nodeFor("- Agent(description=go look)"))).toBe(true);
  });

  it("is null for every other kind of node", () => {
    expect(spawnAgentType(nodeFor("- Bash(command=npm test)"))).toBeNull();
    expect(spawnAgentType(nodeFor("- AgentBuilder(path=/x)"))).toBeNull();
    expect(spawnAgentType(nodeFor("- decided: delegating this"))).toBeNull();
    expect(isAgentSpawn(nodeFor("- Read(file_path=/a.ts)"))).toBe(false);
  });
});

describe("linkAgentSessions", () => {
  const session = (threadId: string, sessionId: string | null, started: string | null, body: string): LinkableSession => ({
    threadId,
    sessionId,
    started,
    nodes: parseSessionNodes(body),
  });

  const PARENT_BODY = [
    "## Task: Do it", // 0
    "- decided: Delegating the search.", // 1
    "- Agent(subagent_type=Explore)", // 2
    "- decided: Back with results.", // 3
    "- Read(file_path=/a.ts)", // 4
  ].join("\n");

  it("links a subagent to the spawn that started it", () => {
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", PARENT_BODY),
      session("b".repeat(16), "s1", "2026-07-23T18:00:10.000Z", "## Task: Search\n- Read(file_path=/b.ts)"),
    ]);

    expect(links.get("b".repeat(16))).toEqual({
      parentThreadId: "a".repeat(16),
      spawnIndex: 2,
      agentType: "Explore",
      returnIndex: 3, // the parent's next non-spawn step
      depth: 1,
      childThreadIds: [],
    });
    expect(links.get("a".repeat(16))).toMatchObject({
      parentThreadId: null,
      depth: 0,
      childThreadIds: ["b".repeat(16)],
    });
  });

  it("leaves returnIndex null while the parent has taken no step after the spawn", () => {
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", "## Task: Do it\n- Agent(subagent_type=Explore)"),
      session("b".repeat(16), "s1", "2026-07-23T18:00:10.000Z", "## Task: Search\n- Read(file_path=/b.ts)"),
    ]);
    expect(links.get("b".repeat(16))).toMatchObject({ spawnIndex: 1, returnIndex: null });
  });

  it("rejoins a parallel spawn batch at the same parent step", () => {
    const body = [
      "## Task: Do it", // 0
      "- decided: Fanning out.", // 1
      "- Agent(subagent_type=Explore)", // 2
      "- Agent(subagent_type=general-purpose)", // 3
      "- Edit(file_path=/b.ts)", // 4
    ].join("\n");
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", body),
      session("b".repeat(16), "s1", "2026-07-23T18:00:05.000Z", "## Task: One"),
      session("c".repeat(16), "s1", "2026-07-23T18:00:06.000Z", "## Task: Two"),
    ]);

    expect(links.get("b".repeat(16))).toMatchObject({ spawnIndex: 2, agentType: "Explore", returnIndex: 4 });
    expect(links.get("c".repeat(16))).toMatchObject({ spawnIndex: 3, agentType: "general-purpose", returnIndex: 4 });
    expect(links.get("a".repeat(16))?.childThreadIds).toEqual(["b".repeat(16), "c".repeat(16)]);
  });

  it("nests a subagent that spawns its own subagent", () => {
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", "## Task: Do it\n- Agent(subagent_type=general-purpose)"),
      session("b".repeat(16), "s1", "2026-07-23T18:00:10.000Z", PARENT_BODY),
      session("c".repeat(16), "s1", "2026-07-23T18:00:20.000Z", "## Task: Deepest"),
    ]);

    expect(links.get("b".repeat(16))).toMatchObject({ parentThreadId: "a".repeat(16), depth: 1 });
    expect(links.get("c".repeat(16))).toMatchObject({ parentThreadId: "b".repeat(16), depth: 2, agentType: "Explore" });
  });

  it("leaves transcripts top-level once the spawns are used up", () => {
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", PARENT_BODY),
      session("b".repeat(16), "s1", "2026-07-23T18:00:10.000Z", "## Task: Search"),
      session("c".repeat(16), "s1", "2026-07-23T18:00:20.000Z", "## Task: Unrelated"),
    ]);

    expect(links.get("b".repeat(16))).toMatchObject({ parentThreadId: "a".repeat(16) });
    expect(links.get("c".repeat(16))).toMatchObject({ parentThreadId: null, depth: 0 });
  });

  it("never claims a transcript that started before its spawner, or one with no start time", () => {
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", PARENT_BODY),
      session("b".repeat(16), "s1", "2026-07-23T17:59:59.000Z", "## Task: Earlier"),
      session("c".repeat(16), "s1", null, "## Task: Undated"),
    ]);

    expect(links.get("b".repeat(16))).toMatchObject({ parentThreadId: null });
    expect(links.get("c".repeat(16))).toMatchObject({ parentThreadId: null });
    expect(links.get("a".repeat(16))?.childThreadIds).toEqual([]);
  });

  it("keeps separate session ids apart and ignores transcripts with none", () => {
    const links = linkAgentSessions([
      session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", PARENT_BODY),
      session("b".repeat(16), "s2", "2026-07-23T18:00:10.000Z", "## Task: Other family"),
      session("c".repeat(16), null, "2026-07-23T18:00:20.000Z", "## Task: No session id"),
    ]);

    expect(links.get("b".repeat(16))).toMatchObject({ parentThreadId: null });
    expect(links.get("c".repeat(16))).toMatchObject({ parentThreadId: null });
  });

  it("gives every transcript a link, even a lone one", () => {
    const links = linkAgentSessions([session("a".repeat(16), "s1", "2026-07-23T18:00:00.000Z", PARENT_BODY)]);
    expect([...links.keys()]).toEqual(["a".repeat(16)]);
    expect(links.get("a".repeat(16))).toEqual({
      parentThreadId: null,
      spawnIndex: null,
      agentType: null,
      returnIndex: null,
      depth: 0,
      childThreadIds: [],
    });
  });
});
