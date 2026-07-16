/**
 * Withheld tools — what the device's `~/.claude/settings.json` keeps *out* of
 * every Claude Code request.
 *
 * A bare tool name in `permissions.deny` (e.g. `"Artifact"`) or a bare-name glob
 * (`"mcp__*"`) removes that tool's schema from Claude's context entirely — it is
 * never sent to the model, so it costs no tokens per turn. A *scoped* rule like
 * `"Bash(rm *)"` does NOT strip the schema; it only blocks matching calls at
 * execution time. This module classifies deny rules into those two buckets and
 * cross-references the schema-stripping ones against tools the proxy actually
 * observed, so the dashboard can confirm a withheld tool is truly absent.
 *
 * Pure: no I/O, no clock. The server reads the settings file and the sidecars
 * and passes them in.
 *
 * See https://code.claude.com/docs/en/permissions.md ("A bare tool name … removes
 * the tool from Claude's context entirely").
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

export interface ObservedToolMatch {
  name: string;
  /** Requests (sampled) in which this tool still appeared. */
  occurrences: number;
  /** Latest ISO timestamp the tool was still present. */
  lastSeen: string;
  bytes: number;
  estTokens: number;
}

export interface WithheldRuleReport {
  rule: string;
  isGlob: boolean;
  /**
   * Observed tools matching this rule that are STILL present in sampled
   * requests. Empty is the healthy state: the rule is withholding the schema as
   * intended. Non-empty means the tool is still reaching the model (config not
   * yet applied, requests predate it, or the name doesn't match).
   */
  stillPresent: ObservedToolMatch[];
}

export interface WithheldReport {
  /** Schema-stripping deny rules, each with any lingering observed matches. */
  rules: WithheldRuleReport[];
  /** Scoped deny rules — surfaced for context; they don't strip schema. */
  scopedRules: string[];
  /** Distinct tool names seen across sampled requests. */
  observedToolCount: number;
  /** Requests inspected. */
  requestsSampled: number;
  /** Rules that still match a present tool (should be 0 once config applies). */
  rulesStillLeaking: number;
}

/**
 * Build the withheld-tools report: classify the device's deny rules and, for
 * each schema-stripping rule, list any observed tools that still slipped through.
 */
export function withheldReport(sidecars: readonly unknown[], deny: readonly string[]): WithheldReport {
  const { schemaStripping, scoped } = classifyDenyRules(deny);

  // Fold sidecars into per-tool observation stats.
  const observed = new Map<string, { occurrences: number; lastSeen: string; bytes: number; estTokens: number }>();
  let requestsSampled = 0;
  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    requestsSampled += 1;
    for (const t of s.tools) {
      const cur = observed.get(t.name) ?? { occurrences: 0, lastSeen: "", bytes: 0, estTokens: 0 };
      cur.occurrences += 1;
      cur.bytes += t.bytes;
      cur.estTokens += t.estTokens;
      if (s.timestamp > cur.lastSeen) cur.lastSeen = s.timestamp;
      observed.set(t.name, cur);
    }
  }

  const rules: WithheldRuleReport[] = schemaStripping.map((rule) => {
    const stillPresent: ObservedToolMatch[] = [...observed.entries()]
      .filter(([name]) => matchesRule(rule, name))
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
    return { rule, isGlob: isGlobRule(rule), stillPresent };
  });

  return {
    rules,
    scopedRules: scoped,
    observedToolCount: observed.size,
    requestsSampled,
    rulesStillLeaking: rules.filter((r) => r.stillPresent.length > 0).length,
  };
}
