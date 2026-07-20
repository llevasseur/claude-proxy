import { describe, expect, it } from "vitest";
import { parseLaunchAliases } from "../src/launch-aliases.js";

describe("parseLaunchAliases", () => {
  it("parses a single-line function with space-separated tools", () => {
    const rc = `claude() { command claude --disallowedTools DesignSync Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)).toEqual([{ name: "claude", withheld: ["DesignSync", "Monitor"] }]);
  });

  it("parses the alias form", () => {
    const rc = `alias claude-mon='command claude --disallowedTools DesignSync "$@"'`;
    expect(parseLaunchAliases(rc)).toEqual([{ name: "claude-mon", withheld: ["DesignSync"] }]);
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
    expect(parseLaunchAliases(rc)).toEqual([{ name: "claude-full", withheld: [] }]);
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
    expect(parseLaunchAliases(rc)).toEqual([{ name: "claude", withheld: ["Monitor"] }]);
  });

  it("dedupes repeated tool names within one alias", () => {
    const rc = `claude() { command claude --disallowedTools Monitor Monitor "$@"; }`;
    expect(parseLaunchAliases(rc)[0]!.withheld).toEqual(["Monitor"]);
  });

  it("parses a multi-line function body", () => {
    const rc = ["claude-mon() {", '  command claude --disallowedTools DesignSync "$@"', "}"].join("\n");
    expect(parseLaunchAliases(rc)).toEqual([{ name: "claude-mon", withheld: ["DesignSync"] }]);
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
    expect(parseLaunchAliases(rc)).toEqual([
      { name: "claude", withheld: ["DesignSync", "Monitor"] },
      { name: "claude-design", withheld: ["Monitor"] },
      { name: "claude-mon", withheld: ["DesignSync"] },
      { name: "claude-full", withheld: [] },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseLaunchAliases("")).toEqual([]);
  });
});
