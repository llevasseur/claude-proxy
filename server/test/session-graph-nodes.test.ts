// `threadIdForBody` only works if it agrees with the proxy function that named the
// transcript, so it is checked against that function itself rather than a golden hash.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { threadIdFor } from "../../proxy/session.mjs";
import { buildSessionGraphNodes } from "../src/api.js";
import { threadIdForBody } from "../src/sessions.js";

const CASES: { name: string; messages: unknown[] }[] = [
  { name: "a plain string prompt", messages: [{ role: "user", content: "Fix the login bug" }] },
  {
    name: "a block-array prompt",
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
      { role: "assistant", content: [{ type: "text", text: "On it." }] },
    ],
  },
  {
    name: "a first turn carrying only a tool result",
    messages: [
      { role: "user", content: [{ type: "tool_result", content: "stale output" }] },
      { role: "user", content: "the real root" },
    ],
  },
  { name: "no user text at all", messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] },
];

describe("threadIdForBody", () => {
  for (const { name, messages } of CASES) {
    it(`hashes ${name} to the same id the proxy does`, () => {
      expect(threadIdForBody("sess-1", messages)).toBe(threadIdFor("sess-1", messages));
    });
  }

  it("agrees with the proxy that a missing session id still names a thread", () => {
    const messages = [{ role: "user", content: "Fix the login bug" }];
    expect(threadIdForBody(null, messages)).toBe(threadIdFor(null, messages));
    expect(threadIdForBody(null, messages)).not.toBe(threadIdForBody("sess-1", messages));
  });

  it("is null for a body with nothing to root on", () => {
    expect(threadIdForBody("sess-1", [])).toBeNull();
    expect(threadIdForBody("sess-1", undefined)).toBeNull();
    expect(threadIdFor("sess-1", [])).toBeNull();
  });
});

describe("buildSessionGraphNodes", () => {
  it("rejects a thread id no transcript claims", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graph-nodes-"));
    await expect(buildSessionGraphNodes(dir, "deadbeefdeadbeef")).rejects.toThrow(
      "session not found: deadbeefdeadbeef",
    );
  });
});
