import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CliRunHandle,
  cliArgs,
  cliEnv,
  cliSettings,
  decodeCliStream,
  findInitEvent,
  resolveAgentCwd,
  runCliTurn,
} from "../src/chat-cli.js";

/** The fields every `cliArgs` call needs; each test overrides what it cares about. */
const base = {
  baseUrl: "http://127.0.0.1:8787",
  model: "claude-opus-5",
  system: "be brief",
  sessionId: "11111111-2222-3333-4444-555555555555",
  resume: false,
};

/** The value passed to a flag, so assertions don't depend on argv ordering. */
const valueOf = (args: string[], flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

describe("cliSettings", () => {
  it("carries the base url so a device settings.json cannot redirect the turn", () => {
    expect(cliSettings("http://127.0.0.1:8787")).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } });
  });

  it("keeps an alias's own overrides alongside it", () => {
    expect(cliSettings("http://proxy", { enableWorkflows: true })).toEqual({
      enableWorkflows: true,
      env: { ANTHROPIC_BASE_URL: "http://proxy" },
    });
  });

  it("lets the base url win over one the alias injects", () => {
    const settings = cliSettings("http://proxy", { env: { ANTHROPIC_BASE_URL: "http://elsewhere", FOO: "1" } });
    expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: "http://proxy", FOO: "1" });
  });
});

describe("cliArgs — chat mode", () => {
  const args = cliArgs({ ...base, mode: "chat" });

  it("locks the child down", () => {
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(valueOf(args, "--tools")).toBe("");
  });

  it("replaces the system prompt rather than appending", () => {
    expect(valueOf(args, "--system-prompt")).toBe("be brief");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("opens the session id it was given", () => {
    expect(valueOf(args, "--session-id")).toBe(base.sessionId);
    expect(args).not.toContain("--resume");
  });
});

describe("cliArgs — agent mode", () => {
  const args = cliArgs({ ...base, mode: "agent", permissionMode: "acceptEdits" });

  it("drops the three flags that would defeat parity", () => {
    expect(args).not.toContain("--safe-mode");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--tools");
  });

  it("appends its system prompt so Claude Code keeps its own", () => {
    expect(valueOf(args, "--append-system-prompt")).toBe("be brief");
    expect(args).not.toContain("--system-prompt");
  });

  it("gives the headless child a standing answer to permission prompts", () => {
    expect(valueOf(args, "--permission-mode")).toBe("acceptEdits");
  });

  it("omits --setting-sources so the CLI's default set loads", () => {
    expect(args).not.toContain("--setting-sources");
  });

  it("replays the tools the device alias withholds", () => {
    const withheld = cliArgs({
      ...base,
      mode: "agent",
      agentFlags: { disallowedTools: ["Monitor", "DesignSync"], settingSources: null, settingsOverrides: null },
    });
    expect(withheld.slice(withheld.indexOf("--disallowed-tools"), withheld.indexOf("--disallowed-tools") + 3)).toEqual([
      "--disallowed-tools",
      "Monitor",
      "DesignSync",
    ]);
  });

  it("passes the alias's setting sources when it names them", () => {
    const scoped = cliArgs({
      ...base,
      mode: "agent",
      agentFlags: { disallowedTools: [], settingSources: ["project", "local"], settingsOverrides: null },
    });
    expect(valueOf(scoped, "--setting-sources")).toBe("project,local");
  });

  it("resumes instead of opening once a turn has been sent", () => {
    const next = cliArgs({ ...base, mode: "agent", resume: true });
    expect(valueOf(next, "--resume")).toBe(base.sessionId);
    expect(next).not.toContain("--session-id");
  });
});

describe("cliEnv", () => {
  it("points the child at the proxy and strips both credentials", () => {
    const env = cliEnv("http://127.0.0.1:8787", {
      ANTHROPIC_API_KEY: "sk-should-not-survive",
      ANTHROPIC_AUTH_TOKEN: "tok",
      PATH: "/usr/bin",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("resolveAgentCwd", () => {
  it("is the checkout of the running server, the same root logs/ resolves against", () => {
    const cwd = resolveAgentCwd();
    expect(path.isAbsolute(cwd)).toBe(true);
    // server/src/chat-cli.ts → ../.. is the repo root, which holds server/.
    expect(path.basename(path.join(cwd, "server"))).toBe("server");
  });
});

describe("decodeCliStream", () => {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;

  it("prefers the terminal result and reads usage off it", () => {
    const raw =
      line({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "partial" }] } }) +
      line({ type: "result", result: "final", usage: { input_tokens: 10, output_tokens: 3 } });
    const out = decodeCliStream(raw);
    expect(out.text).toBe("final");
    expect(out.sessionId).toBe("s1");
    expect(out.usage).toMatchObject({ input: 10, output: 3 });
  });

  it("reads the permission mode the child reports it started under", () => {
    const raw =
      line({ type: "system", subtype: "init", session_id: "s1", permissionMode: "bypassPermissions" }) +
      line({ type: "result", result: "done" });
    expect(decodeCliStream(raw).permissionMode).toBe("bypassPermissions");
  });

  it("leaves the permission mode null when the child never announced one", () => {
    expect(decodeCliStream(line({ type: "result", result: "done" })).permissionMode).toBeNull();
  });

  it("finds the init event in a prefix, and ignores a half-written trailing line", () => {
    const raw = line({ type: "system", subtype: "init", permissionMode: "plan" }) + `{"type":"assis`;
    expect(findInitEvent(raw)).toEqual({ permissionMode: "plan" });
    expect(findInitEvent(`{"type":"assis`)).toBeNull();
  });

  it("falls back to assistant text when a run ends without a result", () => {
    const raw = line({ type: "assistant", message: { content: [{ type: "text", text: "only this" }] } });
    expect(decodeCliStream(raw).text).toBe("only this");
  });

  it("collects the tools an agent turn ran, in order", () => {
    const raw =
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "t1", name: "Read" },
            { type: "tool_use", id: "t2", name: "Bash" },
          ],
        },
      }) + line({ type: "result", result: "done" });
    expect(decodeCliStream(raw).tools).toEqual([
      { name: "Read", failed: false },
      { name: "Bash", failed: false },
    ]);
  });

  it("marks a tool failed from its tool_result", () => {
    const raw =
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }) +
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } }) +
      line({ type: "result", result: "done" });
    expect(decodeCliStream(raw).tools).toEqual([{ name: "Bash", failed: true }]);
  });

  it("carries the tool_result's own text, so a denial reads as one", () => {
    const raw =
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }) +
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: [{ type: "text", text: "Claude requested permissions to use Bash, but you haven't granted it yet." }],
            },
          ],
        },
      }) +
      line({ type: "result", result: "done" });
    expect(decodeCliStream(raw).tools[0].error).toMatch(/requested permissions to use Bash/);
  });

  it("truncates a long tool_result rather than returning a whole command's output", () => {
    const raw =
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }) +
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "x".repeat(2000) }] },
      });
    const error = decodeCliStream(raw).tools[0].error ?? "";
    expect(error.length).toBeLessThan(500);
    expect(error.endsWith("…")).toBe(true);
  });

  it("reports a completed run as not interrupted", () => {
    expect(decodeCliStream(line({ type: "result", result: "hi" })).interrupted).toBeNull();
  });

  it("keeps the partial text and tools of a killed run instead of throwing", () => {
    const raw =
      line({ type: "assistant", message: { content: [{ type: "text", text: "got this far" }] } }) +
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read" }] } }) +
      line({ type: "result", is_error: true, subtype: "error_during_execution" });
    expect(() => decodeCliStream(raw)).toThrow(/error_during_execution/);
    const partial = decodeCliStream(raw, { partial: true });
    expect(partial.text).toBe("got this far");
    expect(partial.tools).toEqual([{ name: "Read", failed: false }]);
  });

  it("reports no tools for a chat turn", () => {
    expect(decodeCliStream(line({ type: "result", result: "hi" })).tools).toEqual([]);
  });

  it("ignores non-JSON chatter", () => {
    const raw = `warning: something\n${line({ type: "result", result: "ok" })}`;
    expect(decodeCliStream(raw).text).toBe("ok");
  });

  it("throws when the run reports an error", () => {
    const raw = line({ type: "result", is_error: true, result: "boom" });
    expect(() => decodeCliStream(raw)).toThrow(/boom/);
  });
});

// --- runCliTurn, against a stand-in for `claude` -----------------------------
//
// The stop path needs a real process: it has to reach the tools an agent turn started,
// not just the CLI, and keep the output the run had already produced.

const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), "chat-cli-test-"));
afterAll(() => fs.rmSync(FIXTURES, { recursive: true, force: true }));

/** Prints one stream-json line, starts a child in its own group, then hangs. */
function fakeCli(name: string): { cliPath: string; childPidFile: string } {
  const cliPath = path.join(FIXTURES, name);
  const childPidFile = path.join(FIXTURES, `${name}.child`);
  fs.writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const line = ${JSON.stringify(
        JSON.stringify({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "partial" }] } }),
      )};`,
      'process.stdout.write(line + "\\n", () => {',
      '  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      `  fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
      "});",
      "setTimeout(() => {}, 60000);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(cliPath, 0o755);
  return { cliPath, childPidFile };
}

const turnInput = (cliPath: string) => ({
  cliPath,
  cwd: FIXTURES,
  baseUrl: "http://127.0.0.1:8787",
  mode: "agent" as const,
  model: "claude-opus-5",
  system: "be brief",
  sessionId: "11111111-2222-3333-4444-555555555555",
  resume: false,
  prompt: "hello",
  timeoutMs: 30_000,
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until `check` holds or the deadline passes; returns whether it held. */
async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe.skipIf(process.platform === "win32")("runCliTurn — ending a run early", () => {
  it("stops the whole process group and returns what the run had reached", async () => {
    const { cliPath, childPidFile } = fakeCli("fake-claude-stop");
    let handle: CliRunHandle | null = null;
    const turn = runCliTurn({ ...turnInput(cliPath), onStart: (run) => (handle = run) });

    expect(await until(() => fs.existsSync(childPidFile))).toBe(true);
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    (handle as unknown as CliRunHandle).stop();

    const result = await turn;
    expect(result.interrupted).toBe("stopped");
    expect(result.text).toBe("partial"); // the prefix that arrived, not discarded
    expect(result.sessionId).toBe("s1");
    // The tool the CLI itself started goes with it, rather than being orphaned.
    expect(await until(() => !alive(childPid))).toBe(true);
  });

  it("reports a timeout the same way rather than throwing the output away", async () => {
    const { cliPath } = fakeCli("fake-claude-timeout");
    const result = await runCliTurn({ ...turnInput(cliPath), timeoutMs: 300 });
    expect(result.interrupted).toBe("timeout");
    expect(result.text).toBe("partial");
  });

  it("still fails loudly when the cli is not there at all", async () => {
    await expect(runCliTurn(turnInput(path.join(FIXTURES, "nope")))).rejects.toThrow(/could not start/);
  });
});
