import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type LaunchAlias, parseLaunchAliases } from "@claude-proxy/core";

/**
 * The device's shell rc — `~/.zshrc` by default, where the user's `claude*`
 * launch aliases live. Override the path with `CLAUDE_SHELL_RC` (tests, bash
 * users, or non-standard homes).
 */
export function resolveShellRcPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SHELL_RC ? path.resolve(env.CLAUDE_SHELL_RC) : path.join(os.homedir(), ".zshrc");
}

export interface ShellLaunchAliases {
  /** Resolved path we read (or tried to read) the rc from. */
  rcPath: string;
  /** False if the file was missing or unreadable. */
  rcReadable: boolean;
  /** `claude*` launch aliases parsed from the rc. Empty when unreadable. */
  aliases: LaunchAlias[];
}

/** Read and parse the `claude*` launch aliases from the device shell rc. Never
 * throws: a missing or unreadable file yields an empty, `rcReadable: false`
 * result. */
export async function readLaunchAliases(rcPath: string = resolveShellRcPath()): Promise<ShellLaunchAliases> {
  try {
    const aliases = parseLaunchAliases(await readFile(rcPath, "utf8"));
    return { rcPath, rcReadable: true, aliases };
  } catch {
    return { rcPath, rcReadable: false, aliases: [] };
  }
}
