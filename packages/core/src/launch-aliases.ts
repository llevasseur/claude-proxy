/**
 * Launch aliases — tools withheld not by settings, but by how a Claude Code
 * session is *launched*.
 *
 * A shell alias/function that runs `claude --disallowedTools <names>` strips
 * those tools' schemas from that session's requests, the same as a bare
 * `permissions.deny` rule, but the flag lives only in the user's shell rc and
 * never reaches the API. So unlike deny rules, launch aliases can't be verified
 * against captured traffic — the proxy can't tell which alias launched a given
 * session. This module parses a shell rc into a declarative list of `claude*`
 * launch aliases and the tools each one withholds; the dashboard renders it as
 * inventory, not a verified status.
 *
 * Pure: no I/O. The server reads the rc file and passes its text in.
 *
 * See https://code.claude.com/docs/en/cli-reference (`--disallowedTools`, a
 * "comma or space-separated list of tool names to deny").
 */

export interface LaunchAlias {
  /** The alias/function name, e.g. `claude`, `claude-design`. */
  name: string;
  /** Tool names the alias withholds via `--disallowedTools` (empty if none). */
  withheld: string[];
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
    out.push({ name: def.name, withheld: extractDisallowed(def.body) });
  }
  return out;
}
