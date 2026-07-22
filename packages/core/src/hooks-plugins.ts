/**
 * Hooks & plugins inventory — what `~/.claude/settings.json` configures, shaped for
 * the dashboard's "Hooks & Plugins" page.
 *
 * This is a *configuration* view, not a runtime one. Hooks are local shell commands
 * Claude Code runs on the machine; they produce no Anthropic API traffic, so the
 * proxy can't observe whether one actually fired — only what's declared. Verifying
 * live firing is done inside a session with `/hooks`.
 *
 * Pure: no I/O — the server reads settings.json and passes the parsed `hooks` /
 * `enabledPlugins` values in.
 */
import type { LaunchAliasPosture } from "./launch-aliases.js";

/** One configured hook command, flattened out of the nested `hooks` object. */
export interface HookRow {
  /** The event that triggers it, e.g. `PreToolUse`, `Stop`. */
  event: string;
  /** Tool-name matcher for the group, or `""` when the group has none. */
  matcher: string;
  /** The shell command run. */
  command: string;
  /** Optional status line Claude Code shows while it runs. */
  statusMessage?: string;
}

/** One entry from `enabledPlugins`, split into name + marketplace. */
export interface PluginRow {
  /** Plugin name (the part before `@`). */
  name: string;
  /** Marketplace it comes from (the part after `@`), or `""` if unqualified. */
  marketplace: string;
  /** Whether the plugin is enabled (`true`) or explicitly disabled (`false`). */
  enabled: boolean;
}

/**
 * Flatten the settings `hooks` object — `{ Event: [{ matcher?, hooks: [{ command,
 * statusMessage? }] }] }` — into one row per command, preserving event and group
 * order. Tolerant of malformed shapes: anything not matching is skipped.
 */
export function flattenHooks(hooks: unknown): HookRow[] {
  const rows: HookRow[] = [];
  if (!hooks || typeof hooks !== "object") return rows;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const g = group as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof g.matcher === "string" ? g.matcher : "";
      if (!Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (!h || typeof h !== "object") continue;
        const hook = h as { command?: unknown; statusMessage?: unknown };
        if (typeof hook.command !== "string") continue;
        rows.push({
          event,
          matcher,
          command: hook.command,
          ...(typeof hook.statusMessage === "string" ? { statusMessage: hook.statusMessage } : {}),
        });
      }
    }
  }
  return rows;
}

/**
 * Normalize the settings `enabledPlugins` map — `{ "name@marketplace": boolean }` —
 * into rows, splitting each key on its last `@`. Non-boolean values are skipped;
 * output follows the map's key order.
 */
export function normalizePlugins(enabledPlugins: unknown): PluginRow[] {
  const rows: PluginRow[] = [];
  if (!enabledPlugins || typeof enabledPlugins !== "object") return rows;
  for (const [key, value] of Object.entries(enabledPlugins as Record<string, unknown>)) {
    if (typeof value !== "boolean") continue;
    const at = key.lastIndexOf("@");
    const name = at >= 0 ? key.slice(0, at) : key;
    const marketplace = at >= 0 ? key.slice(at + 1) : "";
    rows.push({ name, marketplace, enabled: value });
  }
  return rows;
}

/** Whether a launch mode's user hooks / plugins are expected to load. */
export type LoadState = "native" | "not-loaded" | "unverified" | "expected";

export interface AliasLoadExpectation {
  /** The `claude*` alias name. */
  name: string;
  /** Whether user-settings hooks load: `native` (user source loads them),
   * `not-loaded` (user source dropped, nothing re-supplies them), or `unverified`
   * (settings injected dynamically and hooks-via-`--settings` is undocumented). */
  hooks: LoadState;
  /** Whether user-settings plugins load: `native`, `not-loaded`, or `expected`
   * (dynamically injected — plugins-via-`--settings` is supported but not observed here). */
  plugins: LoadState;
}

/**
 * Derive, per launch alias, whether the device's user-settings hooks and plugins are
 * expected to load — from the already-computed launch posture:
 *   - user source loaded            → both `native`
 *   - user source dropped, static   → both `not-loaded` (nothing re-supplies them)
 *   - settings injected dynamically → hooks `unverified`, plugins `expected`
 *     (the dynamic `--settings` likely re-supplies a settings copy; plugins are
 *     supported there, hooks are undocumented — confirm with `/hooks` in-session).
 */
export function hookPluginLoadExpectations(posture: LaunchAliasPosture): AliasLoadExpectation[] {
  return posture.aliases.map((a) => {
    if (a.indeterminate) return { name: a.name, hooks: "unverified", plugins: "expected" };
    if (a.userSettingsLoaded) return { name: a.name, hooks: "native", plugins: "native" };
    return { name: a.name, hooks: "not-loaded", plugins: "not-loaded" };
  });
}
