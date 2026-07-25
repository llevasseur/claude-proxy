/**
 * Proxy filters — the human-readable inventory of what `proxy/proxy.mjs` changes
 * about a Claude Code exchange.
 *
 * Most are edits the CLI can't be configured to make on its own: withheld tools
 * are exempt from `permissions.deny` (denying them in settings is silently
 * ignored), and injected reminders have no suppression setting at all. The proxy
 * is the only place they can be stripped, so the dashboard documents them here.
 *
 * `refused-tool-use` is the one that runs the other way — on the response rather
 * than the request — and the one case where the CLI *does* have its own check;
 * the proxy is a second, out-of-band layer behind it.
 *
 * The proxy is the source of truth for the *actual* behaviour (`WITHHELD_TOOLS`
 * and `INJECTED_REMINDERS` in `proxy/proxy.mjs`, `GUARDED_PATH` in
 * `proxy/guard.mjs`); this module is the description the dashboard renders — keep
 * the two in sync.
 */

export type ProxyFilterKind = "withheld-tool" | "injected-reminder" | "refused-tool-use";

export interface ProxyFilterEntry {
  /** Which mechanism applies it. */
  kind: ProxyFilterKind;
  /** Stable identifier — the tool name, the reminder id, or the guard id. */
  id: string;
  /** Human label for display. */
  label: string;
  /** Why the CLI can't do this without the proxy. */
  reason: string;
  /** How the proxy applies it. */
  mechanism: string;
}

export interface FiltersResponse {
  /** When the server assembled this inventory. */
  generatedAt: string;
  /** Everything the proxy strips, grouped by `kind` in the UI. */
  filters: ProxyFilterEntry[];
}

/** The canonical inventory — mirrors the proxy's runtime constants. */
export const PROXY_FILTER_INVENTORY: ProxyFilterEntry[] = [
  {
    kind: "withheld-tool",
    id: "EndConversation",
    label: "EndConversation",
    reason:
      "The CLI exempts this tool from `permissions.deny`, so denying it in settings is silently ignored and its schema ships on every turn. The proxy is the only place it can be withheld.",
    mechanism: "Removed from the request's `tools` array before forwarding.",
  },
  {
    kind: "injected-reminder",
    id: "task-tools",
    label: "Task-tools nudge",
    reason:
      "A harness-injected reminder to use TaskCreate/TaskUpdate. No CLI setting suppresses it, and a CLAUDE.md instruction doesn't reliably stop it — so it can only be removed at the proxy.",
    mechanism:
      "Matching text is removed from message content before forwarding; a message left empty is dropped.",
  },
  {
    kind: "refused-tool-use",
    id: "permission-config",
    label: "Writes to permission config",
    reason:
      "The CLI's own gate lives in the process it governs and is configured by the very file at risk, so it can't be the only check. `permissions.deny` also scopes `Edit`/`Write` by path but says nothing about `Bash(cat > .claude/settings.json)`, `sed -i`, or `tee` — the proxy sees the call whatever tool carries it.",
    mechanism:
      "The `tool_use` block is held until its input is complete, then replaced with a text block explaining the refusal; the refusal is recorded in the `.audit.json` sidecar.",
  },
];
