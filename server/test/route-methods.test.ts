// The read routes answer under an open `*` CORS, which is only safe while they stay
// reads. The gate lives in the request dispatch, so these drive the real server over a
// socket rather than a handler stub.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "..", "src", "server.ts");
const PORT = 8801 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
/** The device system prompt this server edits — a temp file, never the real one. */
let promptPath: string;

/** `Response.json()` answers `unknown`; these routes always reply with a `prompt` payload. */
async function promptOf(res: Response): Promise<unknown> {
  return ((await res.json()) as { prompt: unknown }).prompt;
}

/** Poll `/api/health` until the listener answers, so a slow `tsx` start isn't a failure. */
async function waitForListening(deadlineMs = 30_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start on ${BASE}`);
}

beforeAll(async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), "route-methods-"));
  promptPath = path.join(logDir, "CLAUDE.md");
  child = spawn("npx", ["tsx", ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: logDir,
      CLAUDE_SYSTEM_PROMPT: promptPath,
    },
    stdio: "ignore",
  });
  await waitForListening();
}, 40_000);

afterAll(() => {
  child?.kill();
});

describe("read routes", () => {
  it("refuses a POST rather than answering it under the open CORS", async () => {
    const res = await fetch(`${BASE}/api/withheld`, { method: "POST" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, OPTIONS");
    expect(await res.json()).toEqual({ error: "method not allowed: POST" });
  });

  it("refuses every other non-GET method too", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${BASE}/api/filters`, { method });
      expect(res.status, method).toBe(405);
    }
  });

  it("still answers the GET it exists for", async () => {
    const res = await fetch(`${BASE}/api/withheld`);
    expect(res.status).toBe(200);
  });

  it("serves the system prompt as a GET, and refuses a save from a foreign origin", async () => {
    const read = await fetch(`${BASE}/api/system-prompt`);
    expect(read.status).toBe(200);
    expect(await promptOf(read)).toMatchObject({ path: promptPath, exists: false });

    // On the write allowlist, so the origin check owns it rather than the 405 gate.
    const foreign = await fetch(`${BASE}/api/system-prompt`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ text: "# owned\n" }),
    });
    expect(foreign.status).toBe(403);
  });

  it("writes the prompt through the save route", async () => {
    const res = await fetch(`${BASE}/api/system-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "# Device rules\r\n" }),
    });

    expect(res.status).toBe(200);
    expect(await promptOf(res)).toMatchObject({ exists: true, text: "# Device rules\n" });
    expect(await readFile(promptPath, "utf8")).toBe("# Device rules\n");
  });

  it("refuses a save whose body isn't a string", async () => {
    const res = await fetch(`${BASE}/api/system-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 42 }),
    });

    expect(res.status).toBe(400);
  });

  it("leaves the write allowlist to its own origin check", async () => {
    // Not 405: the write path owns this route's methods, and refuses a foreign origin
    // under its own origin-checked CORS.
    const res = await fetch(`${BASE}/api/chat/sessions`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
