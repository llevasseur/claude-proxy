import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The device's Claude Code user settings — `~/.claude/settings.json`. This is
 * where the device-wide tool block-list lives (`permissions.deny`), so reading
 * it is what makes the "Not added" view device-specific. Override the path with
 * `CLAUDE_SETTINGS` (handy for tests and non-standard homes).
 */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SETTINGS ? path.resolve(env.CLAUDE_SETTINGS) : path.join(os.homedir(), ".claude", "settings.json");
}

export interface DeviceSettings {
  /** Resolved path we read (or tried to read) the settings from. */
  settingsPath: string;
  /** False if the file was missing or unparseable. */
  readable: boolean;
  /** `permissions.deny` rules, string entries only. Empty when unreadable. */
  denyRules: string[];
}

/** Read `permissions.deny` from the device settings. Never throws: a missing or
 * malformed file yields an empty, `readable: false` result. */
export async function readDeviceSettings(settingsPath: string = resolveSettingsPath()): Promise<DeviceSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { permissions?: { deny?: unknown } };
    const deny = parsed?.permissions?.deny;
    const denyRules = Array.isArray(deny) ? deny.filter((r): r is string => typeof r === "string") : [];
    return { settingsPath, readable: true, denyRules };
  } catch {
    return { settingsPath, readable: false, denyRules: [] };
  }
}
