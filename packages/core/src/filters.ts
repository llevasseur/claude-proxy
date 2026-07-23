/**
 * Proxy request filters — the human-readable inventory of what `proxy/proxy.mjs`
 * removes from every Claude Code request before forwarding.
 *
 * These are edits the CLI can't be configured to make on its own: withheld tools
 * are exempt from `permissions.deny` (denying them in settings is silently
 * ignored), and injected reminders have no suppression setting at all. The proxy
 * is the only place they can be stripped, so the dashboard documents them here.
 *
 * The proxy is the source of truth for the *actual* stripping (`WITHHELD_TOOLS`
 * and `INJECTED_REMINDERS` in `proxy/proxy.mjs`); this module is the description
 * the dashboard renders — keep the two in sync.
 */

export type ProxyFilterKind = "withheld-tool" | "injected-reminder";

export interface ProxyFilterEntry {
  /** Which stripping mechanism removes it. */
  kind: ProxyFilterKind;
  /** Stable identifier — the tool name, or the reminder id. */
  id: string;
  /** Human label for display. */
  label: string;
  /** Why the CLI can't keep it out without the proxy. */
  reason: string;
  /** How the proxy strips it from the request. */
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
];
