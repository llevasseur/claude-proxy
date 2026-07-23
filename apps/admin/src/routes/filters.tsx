import { useQuery } from "@tanstack/react-query";
import type { ProxyFilterEntry, ProxyFilterKind } from "@claude-proxy/core";
import { getFilters } from "../api";
import { QueryState } from "../components/QueryState";

/**
 * "Proxy filters" — the inventory of what `proxy/proxy.mjs` strips out of every
 * request before forwarding it to Anthropic.
 *
 * Unlike the "Not added" page (which reads the device's own `permissions.deny`
 * config), these are edits the CLI can't be told to make on its own: withheld
 * tools are exempt from `permissions.deny`, and injected reminders have no
 * suppression setting at all. The proxy is the only place they can be removed, so
 * this documents exactly what it takes out and why.
 */

const GROUPS: { kind: ProxyFilterKind; title: string; badge: string; blurb: string }[] = [
  {
    kind: "withheld-tool",
    title: "Withheld tools",
    badge: "neutral",
    blurb:
      "Tool schemas the CLI exempts from permissions.deny — denying them in settings does nothing, so the proxy drops them from the request's tools array.",
  },
  {
    kind: "injected-reminder",
    title: "Injected reminders",
    badge: "sev-info",
    blurb:
      "Harness-injected text with no suppression setting. The proxy removes the matching text from message content before forwarding.",
  },
];

function FilterTable({ badge, filters }: { badge: string; filters: ProxyFilterEntry[] }) {
  return (
    <table className="table" style={{ marginTop: 12 }}>
      <thead>
        <tr>
          <th>What</th>
          <th>Why it needs the proxy</th>
          <th>How it's stripped</th>
        </tr>
      </thead>
      <tbody>
        {filters.map((f) => (
          <tr key={f.id}>
            <td>
              <span className={`badge ${badge}`}>{f.label}</span>
            </td>
            <td>{f.reason}</td>
            <td className="muted">{f.mechanism}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FiltersPage() {
  const query = useQuery({ queryKey: ["filters"], queryFn: getFilters });
  const filters = query.data?.filters ?? [];

  return (
    <section>
      <div className="pagehead">
        <h1>Proxy filters</h1>
        <div className="muted">
          What the proxy removes from every request before forwarding — the edits the CLI can't be configured to make on
          its own.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="leak-note">
          <strong>These can't be configured away without the proxy.</strong> Everything listed here is stripped in{" "}
          <span className="rule-name">proxy/proxy.mjs</span> because no <span className="rule-name">~/.claude</span>{" "}
          setting will keep it out: withheld tools are exempt from{" "}
          <span className="rule-name">permissions.deny</span>, and injected reminders have no suppression setting at all.
          Requests with nothing to strip are forwarded byte-for-byte.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {filters.length === 0 ? (
          <div className="card empty">The proxy isn't stripping anything from requests right now.</div>
        ) : (
          GROUPS.map((g) => {
            const rows = filters.filter((f) => f.kind === g.kind);
            if (rows.length === 0) return null;
            return (
              <div className="card" key={g.kind} style={{ marginBottom: 16 }}>
                <div className="muted">
                  <strong>{g.title}</strong> — {g.blurb}
                </div>
                <FilterTable badge={g.badge} filters={rows} />
              </div>
            );
          })
        )}
      </QueryState>
    </section>
  );
}
