import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type JsonInput, type JsonObject, jsonObject, objectField, parseJson, stringArrayField } from './json.js';

/**
 * The device's Claude Code user settings — `~/.claude/settings.json`. This is
 * where the device-wide tool block-list lives (`permissions.deny`), so reading
 * it is what makes the "Not added" view device-specific. Override the path with
 * `CLAUDE_SETTINGS` (handy for tests and non-standard homes).
 */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SETTINGS ? path.resolve(env.CLAUDE_SETTINGS) : path.join(os.homedir(), '.claude', 'settings.json');
}

export interface DeviceSettings {
  /** Resolved path we read (or tried to read) the settings from. */
  settingsPath: string;
  /** False if the file was missing or unparseable. */
  readable: boolean;
  /** `permissions.deny` rules, string entries only. Empty when unreadable. */
  denyRules: string[];
  /** Top-level `disable*` keys set to `true`. Some of these strip a tool schema
   * (resolved to tools downstream in core's `DISABLE_SCHEMA_TOOLS`). Empty when
   * unreadable. */
  enabledDisableKeys: string[];
  /** Raw `hooks` object (event → matcher groups), or `{}` when absent/unreadable.
   * Shaped into rows by core's `flattenHooks`. */
  hooks: JsonObject;
  /** Raw `enabledPlugins` map (`"name@marketplace"` → boolean), or `{}` when
   * absent/unreadable. Shaped into rows by core's `normalizePlugins`. */
  enabledPlugins: JsonObject;
}

/** A plain object, or `{}` when the value isn't one. */
function asObject(value: JsonInput): JsonObject {
  return jsonObject(value) ?? {};
}

/** The answer for a file that is missing or does not parse. */
function unreadable(settingsPath: string): DeviceSettings {
  return { settingsPath, readable: false, denyRules: [], enabledDisableKeys: [], hooks: {}, enabledPlugins: {} };
}

/** Read `permissions.deny`, enabled `disable*` keys, and the `hooks` /
 * `enabledPlugins` config from the device settings. Never throws: a missing or
 * malformed file yields an empty, `readable: false` result. */
export async function readDeviceSettings(settingsPath: string = resolveSettingsPath()): Promise<DeviceSettings> {
  try {
    const parsed = parseJson(await readFile(settingsPath, 'utf8'));
    if (parsed === undefined) return unreadable(settingsPath);
    const settings = asObject(parsed);
    return {
      settingsPath,
      readable: true,
      denyRules: stringArrayField(objectField(parsed, 'permissions'), 'deny'),
      enabledDisableKeys: Object.keys(settings).filter((k) => k.startsWith('disable') && settings[k] === true),
      hooks: asObject(settings.hooks),
      enabledPlugins: asObject(settings.enabledPlugins),
    };
  } catch {
    return unreadable(settingsPath);
  }
}
