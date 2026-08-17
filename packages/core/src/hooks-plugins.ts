/**
 * Hooks & plugins inventory — what `~/.claude/settings.json` configures, shaped for
 * the dashboard's "Hooks & Plugins" page.
 *
 * Config view, not runtime: hooks are local shell commands with no Anthropic API
 * traffic, so the proxy can't observe firing — only what's declared. Verify live
 * firing in-session with `/hooks`.
 *
 * Pure: no I/O — the server reads settings.json and passes the parsed values in.
 */
import { jsonArray, jsonBoolean, jsonEntries, jsonObject, jsonText, jsonValueOf, textAt } from './json.js';
import type { LaunchAliasPosture } from './launch-aliases.js';

/** One configured hook command, flattened out of the nested `hooks` object. */
export interface HookRow {
  /** The event that triggers it. */
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
export function flattenHooks<Candidate>(hooks: Candidate): HookRow[] {
  const rows: HookRow[] = [];
  const byEvent = jsonObject(jsonValueOf(hooks));
  if (byEvent === null) return rows;
  for (const [event, groups] of jsonEntries(byEvent)) {
    const groupList = jsonArray(groups);
    if (groupList === null) continue;
    for (const group of groupList) {
      const groupRecord = jsonObject(group);
      if (groupRecord === null) continue;
      const matcher = textAt(groupRecord, 'matcher');
      const commands = jsonArray(groupRecord.hooks);
      if (commands === null) continue;
      for (const entry of commands) {
        const hook = jsonObject(entry);
        if (hook === null) continue;
        const command = jsonText(hook.command);
        if (command === null) continue;
        const row: HookRow = { event, matcher, command };
        // The key stays absent rather than set to undefined when the hook declares no
        // status line, which is what the page's `in` check reads.
        const statusMessage = jsonText(hook.statusMessage);
        if (statusMessage !== null) row.statusMessage = statusMessage;
        rows.push(row);
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
export function normalizePlugins<Candidate>(enabledPlugins: Candidate): PluginRow[] {
  const rows: PluginRow[] = [];
  const map = jsonObject(jsonValueOf(enabledPlugins));
  if (map === null) return rows;
  for (const [key, entry] of jsonEntries(map)) {
    const value = jsonBoolean(entry);
    if (value === null) continue;
    const at = key.lastIndexOf('@');
    const name = at >= 0 ? key.slice(0, at) : key;
    const marketplace = at >= 0 ? key.slice(at + 1) : '';
    rows.push({ name, marketplace, enabled: value });
  }
  return rows;
}

/** Whether a launch mode's user hooks / plugins are expected to load. */
export type LoadState = 'native' | 'not-loaded' | 'unverified' | 'expected';

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
    if (a.indeterminate) return { name: a.name, hooks: 'unverified', plugins: 'expected' };
    if (a.userSettingsLoaded) return { name: a.name, hooks: 'native', plugins: 'native' };
    return { name: a.name, hooks: 'not-loaded', plugins: 'not-loaded' };
  });
}
