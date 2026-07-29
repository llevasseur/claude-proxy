// The errors page's deep link is only as good as the join behind it, so these drive
// `buildSessionErrors` over a real log dir: a transcript, its sidecar, and the captured
// request the sidecar points at.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionErrors } from "../src/api.js";

const THREAD = "ab3167129339d34f";
const SESSION = "be4b71b3-ccaf-4350-b1aa-b0cf0218897a";
/** The proxy's own capture name — the `_anthropic` suffix is what makes it a valid file handle. */
const STAMP = "2026-07-23T17-40-51-000Z_anthropic";
const NOW = new Date("2026-07-23T18:00:00.000Z");

const TRANSCRIPT = [
  `# Session ${THREAD}`,
  "- model: claude-opus-4-8",
  `- session: ${SESSION}`,
  "- started: 2026-07-23T17:40:51.064Z",
  "",
  "## Task: Fix the login bug",
  "- Bash(command=npm test)",
  "- ✗ ENOENT: no such file",
  "- Edit(file_path=/auth.ts)",
  "- ✗ String to replace not found",
  "",
].join("\n");

/** The same conversation as a captured request: each failure is a `tool_result` block. */
const BODY = {
  messages: [
    { role: "user", content: "Fix the login bug" },
    { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
    { role: "user", content: [{ type: "tool_result", is_error: true, content: "ENOENT: no such file" }] },
    { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/auth.ts" } }] },
    { role: "user", content: [{ type: "tool_result", is_error: true, content: "String to replace not found" }] },
  ],
};

const sidecar = (sessionId: string | null, realInput = 4000) => ({
  timestamp: "2026-07-23T17:40:51.064Z",
  model: "claude-opus-4-8",
  session: sessionId ? { sessionId } : undefined,
  tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, realInput },
  request: { toolCount: 2, toolsBytes: 100, systemBytes: 200, totalBytes: 3000 },
  tools: [],
});

/**
 * A log dir holding one transcript and, unless `body` is null, the captured request
 * behind it. Returns the dir and the request's file handle.
 */
async function fixture(opts: { transcript?: string; body?: unknown; sessionId?: string | null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "session-errors-"));
  await mkdir(path.join(dir, "sessions"), { recursive: true });
  await writeFile(path.join(dir, "sessions", `${THREAD}.md`), opts.transcript ?? TRANSCRIPT);

  const sessionId = opts.sessionId === undefined ? SESSION : opts.sessionId;
  if (opts.body !== null) {
    await writeFile(path.join(dir, `${STAMP}.audit.json`), JSON.stringify(sidecar(sessionId)));
    await writeFile(path.join(dir, `${STAMP}.request.txt`), JSON.stringify(opts.body ?? BODY));
  }
  return { dir, file: STAMP };
}

describe("buildSessionErrors", () => {
  it("points each error at the request message that holds its turn", async () => {
    const { dir, file } = await fixture();
    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors.map((e) => e.text)).toEqual(["ENOENT: no such file", "String to replace not found"]);
    expect(errors.map((e) => e.link)).toEqual([
      { file, messageIndex: 2 },
      { file, messageIndex: 4 },
    ]);
  });

  it("keeps re-linking the error to its task and tool call", async () => {
    const { dir } = await fixture();
    const [first] = await buildSessionErrors(dir, THREAD, NOW).then((r) => r.errors);

    expect(first?.task).toBe("Fix the login bug");
    expect(first?.tool).toBe("Bash(command=npm test)");
  });

  it("leaves an error unlinked when the request went out before it happened", async () => {
    const { dir, file } = await fixture({
      body: { messages: BODY.messages.slice(0, 3) },
    });
    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors.map((e) => e.link)).toEqual([{ file, messageIndex: 2 }, null]);
  });

  it("still lists the errors when no captured request survives", async () => {
    const { dir } = await fixture({ body: null });
    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.link === null)).toBe(true);
  });

  it("still lists the errors when the transcript has no session id to match on", async () => {
    const { dir } = await fixture({
      transcript: TRANSCRIPT.replace(`- session: ${SESSION}\n`, ""),
    });
    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.link === null)).toBe(true);
  });

  it("still lists the errors when the captured request body is unreadable", async () => {
    const { dir } = await fixture();
    await writeFile(path.join(dir, `${STAMP}.request.txt`), "{ not json");
    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.link === null)).toBe(true);
  });

  it("falls past the peak to a smaller request that actually holds the turn", async () => {
    // The biggest capture is a long conversation that never failed; the failures sit in a
    // smaller one, which is where a session with hundreds of requests usually leaves them.
    const { dir } = await fixture({ body: { messages: [{ role: "user", content: "no failures here" }] } });
    const other = "2026-07-23T17-50-00-000Z_anthropic";
    await writeFile(path.join(dir, `${STAMP}.audit.json`), JSON.stringify(sidecar(SESSION, 9000)));
    await writeFile(path.join(dir, `${other}.audit.json`), JSON.stringify(sidecar(SESSION, 1000)));
    await writeFile(path.join(dir, `${other}.request.txt`), JSON.stringify(BODY));

    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors.map((e) => e.link)).toEqual([
      { file: other, messageIndex: 2 },
      { file: other, messageIndex: 4 },
    ]);
  });

  it("ignores requests belonging to a different session", async () => {
    const { dir } = await fixture({ body: { messages: [{ role: "user", content: "no failures here" }] } });
    const stranger = "2026-07-23T17-55-00-000Z_anthropic";
    await writeFile(path.join(dir, `${stranger}.audit.json`), JSON.stringify(sidecar("some-other-session", 9000)));
    await writeFile(path.join(dir, `${stranger}.request.txt`), JSON.stringify(BODY));

    const { errors } = await buildSessionErrors(dir, THREAD, NOW);

    expect(errors.every((e) => e.link === null)).toBe(true);
  });

  it("maps an unknown thread id to the 404 the route expects", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "session-errors-"));
    await expect(buildSessionErrors(dir, "deadbeefdeadbeef")).rejects.toThrow(
      "session not found: deadbeefdeadbeef",
    );
  });
});
