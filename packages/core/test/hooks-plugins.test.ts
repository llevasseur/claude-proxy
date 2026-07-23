import { describe, expect, it } from "vitest";
import { flattenHooks, hookPluginLoadExpectations, normalizePlugins } from "../src/hooks-plugins.js";
import { computeAliasPosture, parseLaunchAliases } from "../src/launch-aliases.js";

describe("flattenHooks", () => {
  it("flattens the nested hooks object into one row per command", () => {
    const hooks = {
      PreToolUse: [
        {
          matcher: "Read|Edit|Write",
          hooks: [{ type: "command", command: "~/.claude/hooks/block-env-files.sh", statusMessage: "Checking…" }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
    };
    expect(flattenHooks(hooks)).toEqual([
      { event: "PreToolUse", matcher: "Read|Edit|Write", command: "~/.claude/hooks/block-env-files.sh", statusMessage: "Checking…" },
      { event: "Stop", matcher: "", command: "notify.sh" },
    ]);
  });

  it("skips malformed entries and non-string commands", () => {
    const hooks = {
      PreToolUse: [{ hooks: [{ type: "command" }, { type: "command", command: 42 }, "nope"] }],
      Bad: "not-an-array",
    };
    expect(flattenHooks(hooks)).toEqual([]);
  });

  it("returns [] for absent or non-object input", () => {
    expect(flattenHooks(undefined)).toEqual([]);
    expect(flattenHooks(null)).toEqual([]);
    expect(flattenHooks("x")).toEqual([]);
  });
});

describe("normalizePlugins", () => {
  it("splits each key on its last @ and keeps the enabled flag", () => {
    const enabledPlugins = {
      "superpowers@claude-plugins-official": false,
      "caveman@caveman": true,
      bare: true,
    };
    expect(normalizePlugins(enabledPlugins)).toEqual([
      { name: "superpowers", marketplace: "claude-plugins-official", enabled: false },
      { name: "caveman", marketplace: "caveman", enabled: true },
      { name: "bare", marketplace: "", enabled: true },
    ]);
  });

  it("skips non-boolean values and returns [] for non-objects", () => {
    expect(normalizePlugins({ "a@m": "yes" })).toEqual([]);
    expect(normalizePlugins(undefined)).toEqual([]);
  });
});

describe("hookPluginLoadExpectations", () => {
  const rc = `
claude()       { command claude "$@"; }
claude-x()     { command claude --setting-sources project,local --disallowedTools Monitor "$@"; }
claude-space() { command claude --setting-sources project,local --settings "$(jq -c '.' ~/.claude/settings.json)" "$@"; }
`;
  const expectations = () => hookPluginLoadExpectations(computeAliasPosture(parseLaunchAliases(rc), [], []));
  const byName = (name: string) => expectations().find((e) => e.name === name)!;

  it("marks native load when the user source is kept", () => {
    expect(byName("claude")).toEqual({ name: "claude", hooks: "native", plugins: "native" });
  });

  it("marks not-loaded when the user source is dropped with static flags", () => {
    expect(byName("claude-x")).toEqual({ name: "claude-x", hooks: "not-loaded", plugins: "not-loaded" });
  });

  it("marks hooks unverified / plugins expected when settings are injected dynamically", () => {
    expect(byName("claude-space")).toEqual({ name: "claude-space", hooks: "unverified", plugins: "expected" });
  });
});
