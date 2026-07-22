import { describe, expect, it } from "vitest";
import { computeAliasPosture, parseLaunchAliases } from "../src/launch-aliases.js";

describe("parseLaunchAliases", () => {
  it("parses a single-line function with space-separated tools", () => {
    const rc = `claude() { command claude --disallowedTools DesignSync Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)).toMatchObject([{ name: "claude", withheld: ["DesignSync", "Monitor"] }]);
  });

  it("parses the alias form", () => {
    const rc = `alias claude-mon='command claude --disallowedTools DesignSync "$@"'`;
    expect(parseLaunchAliases(rc)).toMatchObject([{ name: "claude-mon", withheld: ["DesignSync"] }]);
  });

  it("handles comma-separated tools", () => {
    const rc = `claude() { command claude --disallowedTools DesignSync,Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)[0]!.withheld).toEqual(["DesignSync", "Monitor"]);
  });

  it("strips quotes around individual tool tokens", () => {
    const rc = `claude() { command claude --disallowedTools "DesignSync" "Monitor" "$@"; }`;
    expect(parseLaunchAliases(rc)[0]!.withheld).toEqual(["DesignSync", "Monitor"]);
  });

  it("accepts the --disallowed-tools spelling", () => {
    const rc = `claude() { command claude --disallowed-tools Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)[0]!.withheld).toEqual(["Monitor"]);
  });

  it("returns an empty withheld list when there is no flag (e.g. claude-full)", () => {
    const rc = `claude-full() { command claude "$@"; }`;
    expect(parseLaunchAliases(rc)).toMatchObject([{ name: "claude-full", withheld: [] }]);
  });

  it("ignores non-claude functions", () => {
    const rc = `gh() { command gh --disallowedTools Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)).toEqual([]);
  });

  it("ignores claude* functions that never invoke claude", () => {
    const rc = `claude-notes() { echo "just a note"; }`;
    expect(parseLaunchAliases(rc)).toEqual([]);
  });

  it("keeps the first definition when a name is defined twice", () => {
    const rc = [
      `claude() { command claude --disallowedTools Monitor "$@"; }`,
      `claude() { command claude --disallowedTools DesignSync "$@"; }`,
    ].join("\n");
    expect(parseLaunchAliases(rc)).toMatchObject([{ name: "claude", withheld: ["Monitor"] }]);
  });

  it("dedupes repeated tool names within one alias", () => {
    const rc = `claude() { command claude --disallowedTools Monitor Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)[0]!.withheld).toEqual(["Monitor"]);
  });

  it("parses a multi-line function body", () => {
    const rc = ["claude-mon() {", '  command claude --disallowedTools DesignSync "$@"', "}"].join("\n");
    expect(parseLaunchAliases(rc)).toMatchObject([{ name: "claude-mon", withheld: ["DesignSync"] }]);
  });

  it("parses a realistic rc snippet with several aliases in order", () => {
    const rc = `
# some unrelated config
export PATH="$HOME/go/bin:$PATH"
alias mcl="npx github:llevasseur/my-command"

gh() {
  command gh "$@"
}

# Claude Code launch spaces
claude()        { command claude --disallowedTools DesignSync Monitor "$@"; }
claude-design() { command claude --disallowedTools Monitor "$@"; }
claude-mon()    { command claude --disallowedTools DesignSync "$@"; }
claude-full()   { command claude "$@"; }
`;
    expect(parseLaunchAliases(rc)).toMatchObject([
      { name: "claude", withheld: ["DesignSync", "Monitor"] },
      { name: "claude-design", withheld: ["Monitor"] },
      { name: "claude-mon", withheld: ["DesignSync"] },
      { name: "claude-full", withheld: [] },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseLaunchAliases("")).toEqual([]);
  });

  it("defaults settingSources/settingsOverrides to null when the flags are absent", () => {
    const rc = `claude() { command claude --disallowedTools Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)[0]).toMatchObject({
      settingSources: null,
      settingsOverrides: null,
      settingsDynamic: false,
    });
  });

  it("parses --setting-sources into its comma-separated list", () => {
    const rc = `claude-x() { command claude --setting-sources project,local "$@"; }`;
    expect(parseLaunchAliases(rc)[0]!.settingSources).toEqual(["project", "local"]);
  });

  it("parses inline --settings JSON into an overrides object (not dynamic)", () => {
    const rc = `claude-wf() { command claude --settings '{"disableWorkflows":false}' "$@"; }`;
    expect(parseLaunchAliases(rc)[0]).toMatchObject({
      settingsOverrides: { disableWorkflows: false },
      settingsDynamic: false,
    });
  });

  it("flags --settings as dynamic when its value is an unresolvable shell variable", () => {
    const rc = `claude-y() { command claude --settings "$_cc_on" "$@"; }`;
    expect(parseLaunchAliases(rc)[0]).toMatchObject({ settingsOverrides: null, settingsDynamic: true });
  });

  it("flags --settings as dynamic for a command substitution", () => {
    const rc = `claude-z() { command claude --settings "$(jq -c '.x' ~/.claude/settings.json)" "$@"; }`;
    expect(parseLaunchAliases(rc)[0]).toMatchObject({ settingsOverrides: null, settingsDynamic: true });
  });

  it("flags --settings as dynamic for a file path", () => {
    const rc = `claude-f() { command claude --settings /home/me/space.json "$@"; }`;
    expect(parseLaunchAliases(rc)[0]).toMatchObject({ settingsOverrides: null, settingsDynamic: true });
  });
});

describe("computeAliasPosture", () => {
  // Mirrors the real device: user settings.json denies both tools + disables
  // Workflows; the shell rc's "on" variants skip the user source to re-enable them.
  // (Static flags only, so every alias is determinate — see the indeterminate block.)
  const deny = ["DesignSync", "Monitor", "Artifact"];
  const enabledDisableKeys = ["disableWorkflows"];
  const rc = `
claude()          { command claude "$@"; }
claude-design()   { command claude --setting-sources project,local --disallowedTools Monitor "$@"; }
claude-mon()      { command claude --setting-sources project,local --disallowedTools DesignSync "$@"; }
claude-full()     { command claude --setting-sources project,local "$@"; }
claude-workflow() { command claude --settings '{"disableWorkflows":false}' "$@"; }
`;

  const posture = () => computeAliasPosture(parseLaunchAliases(rc), deny, enabledDisableKeys);
  const byName = (name: string) => posture().aliases.find((a) => a.name === name)!;

  it("surfaces only the tools that vary as columns (constant Artifact stays out)", () => {
    expect(posture().columns).toEqual(["DesignSync", "Monitor", "Workflow"]);
  });

  it("distinguishes claude / claude-full / claude-workflow instead of all reading nothing", () => {
    expect(byName("claude").cells).toEqual({ DesignSync: true, Monitor: true, Workflow: true });
    expect(byName("claude-full").cells).toEqual({ DesignSync: false, Monitor: false, Workflow: false });
    expect(byName("claude-workflow").cells).toEqual({ DesignSync: true, Monitor: true, Workflow: false });
  });

  it("re-denies one tool while dropping the user source for the -design/-mon variants", () => {
    expect(byName("claude-design").cells).toEqual({ DesignSync: false, Monitor: true, Workflow: false });
    expect(byName("claude-mon").cells).toEqual({ DesignSync: true, Monitor: false, Workflow: false });
  });

  it("marks whether the user settings source still loads", () => {
    expect(byName("claude").userSettingsLoaded).toBe(true);
    expect(byName("claude-workflow").userSettingsLoaded).toBe(true);
    expect(byName("claude-design").userSettingsLoaded).toBe(false);
  });

  it("reports collateral re-enabled tools (Artifact) for user-source-skipping aliases", () => {
    expect(byName("claude-full").alsoReenabled).toContain("Artifact");
    expect(byName("claude").alsoReenabled).toEqual([]);
    expect(byName("claude-workflow").alsoReenabled).toEqual([]);
  });

  it("computes the full effective withheld set, applying --settings scalar overrides", () => {
    // claude-workflow keeps the user deny but --settings turns Workflow back on.
    expect(byName("claude-workflow").withheld).toEqual(["Artifact", "DesignSync", "Monitor"]);
    // claude-full skips the user source and re-denies nothing → withholds nothing.
    expect(byName("claude-full").withheld).toEqual([]);
  });

  it("has no columns when no alias manipulates tools", () => {
    const flat = computeAliasPosture(parseLaunchAliases(`claude() { command claude "$@"; }`), deny, enabledDisableKeys);
    expect(flat.columns).toEqual([]);
    expect(flat.aliases[0]!.withheld).toEqual(["Artifact", "DesignSync", "Monitor", "Workflow"]);
  });

  it("marks determinate aliases as not indeterminate", () => {
    expect(byName("claude").indeterminate).toBe(false);
    expect(byName("claude-design").indeterminate).toBe(false);
  });

  describe("dynamic --settings (indeterminate)", () => {
    // The real "spaces" derive settings live via jq — a value the rc parser can't read.
    const dynRc = `
claude()       { command claude "$@"; }
claude-space() { command claude --setting-sources project,local --settings "$(jq -c '.permissions.deny -= ["DesignSync"]' ~/.claude/settings.json)" "$@"; }
`;
    const dyn = () => computeAliasPosture(parseLaunchAliases(dynRc), deny, enabledDisableKeys);
    const space = () => dyn().aliases.find((a) => a.name === "claude-space")!;

    it("marks the alias indeterminate with empty posture", () => {
      expect(space().indeterminate).toBe(true);
      expect(space().withheld).toEqual([]);
      expect(space().cells).toEqual({});
      expect(space().alsoReenabled).toEqual([]);
    });

    it("does not let an indeterminate alias skew the columns", () => {
      // Only `claude` is determinate and it toggles nothing, so no columns emerge —
      // the dynamic alias must not fabricate a "withholds nothing" that varies.
      expect(dyn().columns).toEqual([]);
    });

    it("still reports whether the user source is dropped", () => {
      expect(space().userSettingsLoaded).toBe(false);
    });
  });
});
