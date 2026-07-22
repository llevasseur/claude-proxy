/**
 * Launch aliases — tools withheld by how a Claude Code session is launched, not
 * by settings. A shell alias/function running `claude` with launch flags can
 * change which tool schemas reach the model, but those flags live only in the
 * shell rc and never reach the API — so, unlike `permissions.deny` rules, these
 * can't be verified against captured traffic; the posture below is *computed*
 * from settings precedence, not observed. Parses a shell rc into a declarative
 * list of `claude*` aliases and the launch flags each passes.
 *
 * Three flags move a tool's schema in or out of a session, and this module reads
 * all three (see https://code.claude.com/docs/en/cli-reference):
 *   - `--disallowedTools <names>` — a bare name strips that tool's schema; a
 *     scoped `Name(...)` rule only blocks calls. Layers on top of settings deny.
 *   - `--setting-sources <list>` — *replaces* the default source set (user,
 *     project, local). Omitting `user` means `~/.claude/settings.json` isn't
 *     loaded at all, so its whole `permissions.deny` list and `disable*` keys
 *     stop applying — re-exposing everything they withheld.
 *   - `--settings <json>` — overrides matching keys for the session (a merge,
 *     not a replace); e.g. `{"disableWorkflows":false}` re-enables the Workflow
 *     tool even when the file sets it `true`.
 *
 * Pure: no I/O — the server reads the rc file and passes its text in.
 */
import { activeDisableSchemaKeys, classifyDenyRules } from "./withheld.js";

export interface LaunchAlias {
  /** The alias/function name, e.g. `claude`, `claude-design`. */
  name: string;
  /** Tool names the alias withholds via `--disallowedTools` (empty if none). */
  withheld: string[];
  /** Sources named in `--setting-sources` (e.g. `["project","local"]`). `null`
   * when the flag is absent — the default set (user, project, local) then loads,
   * so the device's user settings.json applies in full. */
  settingSources: string[] | null;
  /** Parsed inline `--settings` JSON object, or `null` when the flag is absent or
   * its value can't be resolved statically (a shell variable like `$_cc_on`, or a
   * file path). Only the `disable*` booleans within it affect tool posture. */
  settingsOverrides: Record<string, unknown> | null;
}

/** A `claude*` name: `claude`, or `claude-<suffix>`. */
const CLAUDE_NAME = /^claude(-[A-Za-z0-9_-]+)?$/;

/** The body actually invokes `claude` (as a word, not just the alias name). */
const INVOKES_CLAUDE = /(^|[\s;&|(])claude\b/;

interface RawDef {
  name: string;
  body: string;
}

/**
 * Pull the tool names out of a `--disallowedTools` / `--disallowed-tools` flag
 * in a command body. The list runs until the next flag, `$@`, `;`, `}`, or end
 * of string; names may be comma- or space-separated and individually quoted.
 */
function extractDisallowed(body: string): string[] {
  const m = body.match(/--disallowed-?[tT]ools\s+(.+?)(?=\s+-|\s*["']?\$@|\s*;|\s*\}|$)/);
  if (!m) return [];
  const tools: string[] = [];
  for (const raw of (m[1] ?? "").split(/[\s,]+/)) {
    const t = raw.replace(/^['"]+|['"]+$/g, "");
    if (t.length > 0 && !t.includes("$@") && !tools.includes(t)) tools.push(t);
  }
  return tools;
}

/**
 * Grab a flag's single argument from a command body: the next quoted string or
 * bare token after `--<flag>`. Surrounding quotes are stripped; returns `null`
 * when the flag is absent.
 */
function extractFlagArg(body: string, flagPattern: string): string | null {
  const m = body.match(new RegExp(`${flagPattern}\\s+('[^']*'|"[^"]*"|\\S+)`));
  if (!m) return null;
  return (m[1] ?? "").replace(/^['"]|['"]$/g, "");
}

/**
 * Parse `--setting-sources <list>` into its comma-separated source names, or
 * `null` when the flag is absent (the default user+project+local set then loads).
 */
function extractSettingSources(body: string): string[] | null {
  const raw = extractFlagArg(body, "--setting-?[sS]ources");
  if (raw === null) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the inline `--settings <json>` object. Returns `null` when the flag is
 * absent or its value isn't a static JSON object (e.g. a shell variable like
 * `$_cc_on` or a file path) — such values can't be resolved from the rc text.
 */
function extractSettingsOverrides(body: string): Record<string, unknown> | null {
  const raw = extractFlagArg(body, "--settings");
  if (raw === null || raw.includes("$")) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract shell function and alias definitions from rc text. Handles zsh
 * function forms (`name() { … }`, `function name { … }`, single- or multi-line)
 * and alias forms (`alias name='…'`). Only explicit function/alias syntax is
 * matched, so ordinary command lines (e.g. `command -v foo`) are never mistaken
 * for definitions.
 */
function extractDefs(rc: string): RawDef[] {
  const defs: RawDef[] = [];
  const lines = rc.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const aliasM = line.match(/^\s*alias\s+([A-Za-z0-9_-]+)=(['"])([\s\S]*?)\2\s*$/);
    if (aliasM) {
      defs.push({ name: aliasM[1]!, body: aliasM[3]! });
      continue;
    }

    const fnM = line.match(/^\s*(?:function\s+([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)\s*\(\))\s*(\{?)(.*)$/);
    if (!fnM) continue;
    const name = fnM[1] ?? fnM[2]!;
    const rest = fnM[4] ?? "";

    // Single-line body: `name() { … }` — take everything before the last brace.
    if (rest.includes("}")) {
      defs.push({ name, body: rest.slice(0, rest.lastIndexOf("}")) });
      continue;
    }

    // Multi-line body: accumulate until the closing brace, only when the header
    // actually opened one (`{`), so a bare `name()` with no block is skipped.
    if (fnM[3] === "{" || rest.includes("{")) {
      const parts = [rest];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.includes("}")) {
          parts.push(l.slice(0, l.indexOf("}")));
          break;
        }
        parts.push(l);
      }
      defs.push({ name, body: parts.join(" ") });
      i = j;
    }
  }
  return defs;
}

/**
 * Parse a shell rc file's text into the `claude*` launch aliases it defines and
 * the tools each withholds. Keeps only names matching `claude` / `claude-*`
 * whose body actually invokes `claude`; the first definition of a name wins.
 * Source order is preserved.
 */
export function parseLaunchAliases(rc: string): LaunchAlias[] {
  const out: LaunchAlias[] = [];
  const seen = new Set<string>();
  for (const def of extractDefs(rc)) {
    if (!CLAUDE_NAME.test(def.name)) continue;
    if (!INVOKES_CLAUDE.test(def.body)) continue;
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    out.push({
      name: def.name,
      withheld: extractDisallowed(def.body),
      settingSources: extractSettingSources(def.body),
      settingsOverrides: extractSettingsOverrides(def.body),
    });
  }
  return out;
}

/** A grid column: a tool explicitly toggled by some alias whose effective on/off
 * state also varies across aliases. Constant tools are left out of the grid. */
export interface AliasPosture {
  /** The alias/function name. */
  name: string;
  /** Whether the user settings source still loads for this alias — i.e. its
   * `permissions.deny` and `disable*` keys apply (false when `--setting-sources`
   * drops `user`). Also governs whether user plugins/hooks load. */
  userSettingsLoaded: boolean;
  /** Full effective set of schema-stripped (withheld) tools, sorted. */
  withheld: string[];
  /** Per grid-column tool: `true` = withheld (off), `false` = available (on). */
  cells: Record<string, boolean>;
  /** Device-denied tools this alias re-exposes purely by skipping user settings,
   * excluding any already shown as a column — the collateral of `--setting-sources`.
   * Sorted; empty when the alias keeps user settings. */
  alsoReenabled: string[];
}

export interface LaunchAliasPosture {
  /** Grid columns: tools explicitly toggled by some alias that vary across them. */
  columns: string[];
  /** Per-alias effective posture, in source order. */
  aliases: AliasPosture[];
}

/** Schema-stripping tools an alias withholds via `--disallowedTools` (bare names
 * only; scoped `Name(...)` rules don't strip a schema). */
function disallowedSchemaTools(alias: LaunchAlias): string[] {
  return alias.withheld.filter((t) => !t.includes("("));
}

/** The `disable*` keys an alias turns into `true` via inline `--settings`, mapped
 * to the tools they strip (unknown/ non-schema disable keys are ignored). */
function overriddenDisableTools(alias: LaunchAlias, enable: boolean): string[] {
  const overrides = alias.settingsOverrides ?? {};
  const keys = Object.entries(overrides)
    .filter(([k, v]) => k.startsWith("disable") && v === enable)
    .map(([k]) => k);
  return activeDisableSchemaKeys(keys).flatMap((e) => e.tools);
}

/**
 * The effective set of schema-stripped tools for one alias, applying settings
 * precedence: the device deny list and `disable*` keys apply only when the user
 * source still loads; inline `--settings` overrides those `disable*` keys; and
 * `--disallowedTools` bare names layer on top.
 */
function effectiveWithheld(
  alias: LaunchAlias,
  denyTools: readonly string[],
  enabledDisableKeys: readonly string[],
): { withheld: Set<string>; userSettingsLoaded: boolean } {
  const userSettingsLoaded = alias.settingSources === null || alias.settingSources.includes("user");
  const set = new Set<string>();

  if (userSettingsLoaded) for (const t of denyTools) set.add(t);

  // disable* keys: the device's enabled keys (only when user settings load),
  // then apply this alias's inline --settings overrides in both directions.
  const disableKeys = new Set<string>(userSettingsLoaded ? enabledDisableKeys : []);
  const overrides = alias.settingsOverrides ?? {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!k.startsWith("disable")) continue;
    if (v === true) disableKeys.add(k);
    else if (v === false) disableKeys.delete(k);
  }
  for (const e of activeDisableSchemaKeys([...disableKeys])) for (const t of e.tools) set.add(t);

  for (const t of disallowedSchemaTools(alias)) set.add(t);

  return { withheld: set, userSettingsLoaded };
}

/**
 * Compute each alias's *net effective* tool posture from the launch flags plus
 * the device settings, then pick the grid columns — tools some alias explicitly
 * toggles (`--disallowedTools`, or a `disable*` key via `--settings`) whose on/off
 * state actually varies across the aliases. Tools re-exposed only as collateral of
 * `--setting-sources` dropping the user source are reported per alias in
 * `alsoReenabled` rather than exploding the grid.
 *
 * Pure: `deny` is the device `permissions.deny`; `enabledDisableKeys` its enabled
 * top-level `disable*` booleans (as `withheldReport` receives them).
 */
export function computeAliasPosture(
  aliases: readonly LaunchAlias[],
  deny: readonly string[],
  enabledDisableKeys: readonly string[] = [],
): LaunchAliasPosture {
  const denyTools = classifyDenyRules(deny).schemaStripping;
  const baseline = new Set<string>([
    ...denyTools,
    ...activeDisableSchemaKeys(enabledDisableKeys).flatMap((e) => e.tools),
  ]);

  const eff = aliases.map((a) => ({ alias: a, ...effectiveWithheld(a, denyTools, enabledDisableKeys) }));

  // Tools an alias explicitly manipulates via its own flags — the only candidates
  // for a grid column (collateral from skipping user settings stays in the notes).
  const explicit = new Set<string>();
  for (const a of aliases) {
    for (const t of disallowedSchemaTools(a)) explicit.add(t);
    for (const t of overriddenDisableTools(a, true)) explicit.add(t);
    for (const t of overriddenDisableTools(a, false)) explicit.add(t);
  }

  const columns = [...explicit]
    .filter((tool) => {
      const states = eff.map((e) => e.withheld.has(tool));
      return states.some((s) => s) && states.some((s) => !s);
    })
    .sort((a, b) => a.localeCompare(b));
  const columnSet = new Set(columns);

  const postureAliases: AliasPosture[] = eff.map(({ alias, withheld, userSettingsLoaded }) => {
    const cells: Record<string, boolean> = {};
    for (const c of columns) cells[c] = withheld.has(c);
    const alsoReenabled = [...baseline]
      .filter((t) => !withheld.has(t) && !columnSet.has(t))
      .sort((a, b) => a.localeCompare(b));
    return {
      name: alias.name,
      userSettingsLoaded,
      withheld: [...withheld].sort((a, b) => a.localeCompare(b)),
      cells,
      alsoReenabled,
    };
  });

  return { columns, aliases: postureAliases };
}
