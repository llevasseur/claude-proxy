// The env default is validated the same way the request field is: unchecked, it reaches
// the child and the form's select.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentConfig } from "../src/chat.js";

const ENV = process.env.CHAT_AGENT_PERMISSION_MODE;
afterEach(() => {
  if (ENV === undefined) delete process.env.CHAT_AGENT_PERMISSION_MODE;
  else process.env.CHAT_AGENT_PERMISSION_MODE = ENV;
  vi.restoreAllMocks();
});

describe("CHAT_AGENT_PERMISSION_MODE", () => {
  it("takes a mode the CLI defines", async () => {
    process.env.CHAT_AGENT_PERMISSION_MODE = "bypassPermissions";
    expect((await resolveAgentConfig()).permissionMode).toBe("bypassPermissions");
  });

  it("falls back to acceptEdits and warns on anything else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CHAT_AGENT_PERMISSION_MODE = "acceptedits";
    expect((await resolveAgentConfig()).permissionMode).toBe("acceptEdits");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CHAT_AGENT_PERMISSION_MODE"));
  });

  it("defaults to acceptEdits when unset", async () => {
    delete process.env.CHAT_AGENT_PERMISSION_MODE;
    expect((await resolveAgentConfig()).permissionMode).toBe("acceptEdits");
  });
});
