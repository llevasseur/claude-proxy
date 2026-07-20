/**
 * Withheld tools — what the device's `~/.claude/settings.json` keeps *out* of
 * every Claude Code request.
 *
 * There are two device-wide ways to strip a tool's schema, and this module
 * reports both:
 *
 * 1. A bare tool name in `permissions.deny` (e.g. `"Artifact"`) or a bare-name
 *    glob (`"mcp__*"`) removes that tool's schema from Claude's context entirely
 *    — never sent to the model, so it costs no tokens per turn. A *scoped* rule
 *    like `"Bash(rm *)"` does NOT strip the schema; it only blocks matching calls
 *    at execution time.
 * 2. A boolean `disable*` setting (e.g. `"disableWorkflows": true`) drops a
 *    specific tool's schema the same way, but without a `permissions.deny` entry —
 *    so it's invisible to the deny-rule view even though the token savings are
 *    identical. `DISABLE_SCHEMA_TOOLS` maps each such key to the tool(s) it removes.
 *
 * This module classifies deny rules into schema-stripping vs scoped, resolves the
 * device's enabled `disable*` keys to their tools, and cross-references both
 * against tools the proxy actually observed, so the dashboard can confirm a
 * withheld tool is truly absent.
 *
 * Pure: no I/O, no clock. The server reads the settings file and the sidecars
 * and passes them in.
 *
 * See https://code.claude.com/docs/en/permissions.md ("A bare tool name … removes
 * the tool from Claude's context entirely") and
 * https://code.claude.com/docs/en/settings.md (the `disable*` keys).
 */
import { isAuditSidecar } from "./types.js";

/** A deny rule is *scoped* (and so not schema-stripping) iff it has a `(...)`
 * specifier. Everything else — a bare name or a bare-name glob — strips schema. */
export function isScopedRule(rule: string): boolean {
  return rule.includes("(");
}

/** Does a schema-stripping deny rule contain a `*` wildcard? */
export function isGlobRule(rule: string): boolean {
  return rule.includes("*");
}

/**
 * Match a tool name against a bare deny rule. Exact string unless the rule
 * contains `*`, which matches any run of characters (the only wildcard Claude
 * Code's tool-name globs support). Anchored to the full name.
 */
export function matchesRule(rule: string, toolName: string): boolean {
  if (!isGlobRule(rule)) return rule === toolName;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

export interface DenyRuleClassification {
  /** Bare names / bare-name globs — these remove the schema from context. */
  schemaStripping: string[];
  /** Scoped rules (`Name(...)`) — block calls but still send the schema. */
  scoped: string[];
}

/** Split a `permissions.deny` array into schema-stripping vs scoped rules. */
export function classifyDenyRules(deny: readonly string[]): DenyRuleClassification {
  const schemaStripping: string[] = [];
  const scoped: string[] = [];
  for (const rule of deny) {
    if (typeof rule !== "string" || rule.length === 0) continue;
    (isScopedRule(rule) ? scoped : schemaStripping).push(rule);
  }
  return { schemaStripping, scoped };
}

/**
 * Boolean `disable*` settings that strip a specific tool's schema from every
 * request — the non-deny path to withholding a tool. When the key is `true`,
 * Claude Code drops the mapped tool(s) from the request entirely, exactly like a
 * bare deny rule, but there is no `permissions.deny` entry to see. Only keys that
 * map to an observable tool schema belong here; other `disable*` settings (hooks,
 * agent view, remote control, …) don't remove a tool and are intentionally omitted.
 *
 * See https://code.claude.com/docs/en/settings.md and
 * https://code.claude.com/docs/en/workflows.md ("disableWorkflows").
 */
export const DISABLE_SCHEMA_TOOLS: Readonly<Record<string, readonly string[]>> = {
  disableWorkflows: ["Workflow"],
  disableArtifact: ["Artifact"],
};

export interface DisableSchemaEntry {
  /** The settings key, e.g. `disableWorkflows`. */
  key: string;
  /** Tool name(s) the key removes from every request. */
  tools: string[];
}

/**
 * Resolve the device's enabled `disable*` keys to the tools they withhold,
 * keeping only keys known to strip a schema (`DISABLE_SCHEMA_TOOLS`). Output
 * follows `DISABLE_SCHEMA_TOOLS` order for stability; unknown keys are ignored.
 */
export function activeDisableSchemaKeys(enabledKeys: readonly string[]): DisableSchemaEntry[] {
  const enabled = new Set(enabledKeys);
  return Object.entries(DISABLE_SCHEMA_TOOLS)
    .filter(([key]) => enabled.has(key))
    .map(([key, tools]) => ({ key, tools: [...tools] }));
}

export interface ObservedToolMatch {
  name: string;
  /** Requests (sampled) in which this tool appeared. */
  occurrences: number;
  /** Latest ISO timestamp the tool was seen. */
  lastSeen: string;
  /** True if the tool was in the most recent tool-bearing request in the sample. */
  inLatestRequest: boolean;
  bytes: number;
  estTokens: number;
}

/**
 * Per-rule status against sampled traffic:
 * - `absent`: no observed tool matches — the schema is being withheld as intended.
 * - `was-present`: matched only in older requests. Pre-config history aging out
 *   of the window (or a session that has since been restarted); not live.
 * - `still-present`: matched in the most recent captured request — the tool is
 *   still reaching the model right now (a session predating the rule is still
 *   running, or the rule isn't matching: name typo / settings precedence).
 */
export type WithheldStatus = "absent" | "was-present" | "still-present";

export interface WithheldRuleReport {
  rule: string;
  isGlob: boolean;
  status: WithheldStatus;
  /** Observed tools matching this rule, ranked by occurrences. Empty when absent. */
  observed: ObservedToolMatch[];
}

/**
 * Per-`disable*`-setting status against sampled traffic, mirroring
 * `WithheldRuleReport` but keyed by the settings key rather than a deny rule.
 */
export interface DisableSchemaReport {
  /** The settings key that withholds the tool(s), e.g. `disableWorkflows`. */
  key: string;
  /** Tool name(s) the key removes from every request. */
  tools: string[];
  status: WithheldStatus;
  /** Observed tools matching this key's tools, ranked by occurrences. Empty when absent. */
  observed: ObservedToolMatch[];
}

export interface WithheldReport {
  /** Schema-stripping deny rules, each with its status + observed matches. */
  rules: WithheldRuleReport[];
  /** Scoped deny rules — surfaced for context; they don't strip schema. */
  scopedRules: string[];
  /** Enabled schema-stripping `disable*` settings, each with status + matches. */
  disableSchema: DisableSchemaReport[];
  /** Distinct tool names seen across sampled requests. */
  observedToolCount: number;
  /** Requests inspected. */
  requestsSampled: number;
  /** Timestamp of the most recent tool-bearing request, or null if none. */
  latestRequestTs: string | null;
  /** Rules still reaching the model in the latest request (should reach 0). */
  rulesStillPresent: number;
  /** Rules present only in older requests — aging-out history. */
  rulesWasPresent: number;
  /** `disable*` withholds still reaching the model in the latest request (should reach 0). */
  disableStillPresent: number;
  /** `disable*` withholds present only in older requests — aging-out history. */
  disableWasPresent: number;
}

/**
 * Build the withheld-tools report: classify the device's deny rules, resolve its
 * enabled `disable*` keys to tools, and for each schema-stripping rule and each
 * disable key decide whether matching tools are absent, only lingering in older
 * requests (`was-present`), or still in the latest request (`still-present`).
 * "Latest" is the newest tool-bearing request in the sample.
 *
 * `enabledDisableKeys` is the device's top-level `disable*` booleans set to
 * `true`; only those in `DISABLE_SCHEMA_TOOLS` produce a `disableSchema` entry.
 */
export function withheldReport(
  sidecars: readonly unknown[],
  deny: readonly string[],
  enabledDisableKeys: readonly string[] = [],
): WithheldReport {
  const { schemaStripping, scoped } = classifyDenyRules(deny);

  // Fold sidecars into per-tool observation stats, tracking the newest
  // tool-bearing request so we can tell live leakage from aging-out history.
  const observed = new Map<string, { occurrences: number; lastSeen: string; bytes: number; estTokens: number }>();
  let requestsSampled = 0;
  let latestRequestTs: string | null = null;
  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    requestsSampled += 1;
    if (s.tools.length > 0 && (latestRequestTs === null || s.timestamp > latestRequestTs)) {
      latestRequestTs = s.timestamp;
    }
    for (const t of s.tools) {
      const cur = observed.get(t.name) ?? { occurrences: 0, lastSeen: "", bytes: 0, estTokens: 0 };
      cur.occurrences += 1;
      cur.bytes += t.bytes;
      cur.estTokens += t.estTokens;
      if (s.timestamp > cur.lastSeen) cur.lastSeen = s.timestamp;
      observed.set(t.name, cur);
    }
  }

  // Collect observed tools whose name satisfies `predicate`, ranked, plus the
  // derived status. Shared by deny rules and disable-key withholds.
  const collect = (predicate: (name: string) => boolean): { observed: ObservedToolMatch[]; status: WithheldStatus } => {
    const matches: ObservedToolMatch[] = [...observed.entries()]
      .filter(([name]) => predicate(name))
      .map(([name, v]) => ({ name, ...v, inLatestRequest: latestRequestTs !== null && v.lastSeen === latestRequestTs }))
      .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
    const status: WithheldStatus =
      matches.length === 0 ? "absent" : matches.some((m) => m.inLatestRequest) ? "still-present" : "was-present";
    return { observed: matches, status };
  };

  const rules: WithheldRuleReport[] = schemaStripping.map((rule) => {
    const { observed: matches, status } = collect((name) => matchesRule(rule, name));
    return { rule, isGlob: isGlobRule(rule), status, observed: matches };
  });

  const disableSchema: DisableSchemaReport[] = activeDisableSchemaKeys(enabledDisableKeys).map(({ key, tools }) => {
    const toolSet = new Set(tools);
    const { observed: matches, status } = collect((name) => toolSet.has(name));
    return { key, tools, status, observed: matches };
  });

  return {
    rules,
    scopedRules: scoped,
    disableSchema,
    observedToolCount: observed.size,
    requestsSampled,
    latestRequestTs,
    rulesStillPresent: rules.filter((r) => r.status === "still-present").length,
    rulesWasPresent: rules.filter((r) => r.status === "was-present").length,
    disableStillPresent: disableSchema.filter((d) => d.status === "still-present").length,
    disableWasPresent: disableSchema.filter((d) => d.status === "was-present").length,
  };
}
