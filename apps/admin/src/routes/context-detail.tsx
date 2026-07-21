import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { BreakdownMessage, BreakdownTool, RequestBreakdown } from "@claude-proxy/core";
import { getContextDetail } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt, fmtPct } from "../format";

export function ContextDetailPage() {
  const { file } = useParams({ from: "/context/$file" });
  const query = useQuery({ queryKey: ["context-detail", file], queryFn: () => getContextDetail(file) });
  const data = query.data;

  return (
    <section>
      <div className="pagehead">
        <h1>Request breakdown</h1>
        <Link to="/context" className="link">
          ‹ back to context
        </Link>
      </div>
      <div className="muted" style={{ marginBottom: "0.75rem", wordBreak: "break-all" }}>{file}</div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {data && <DetailBody file={file} breakdown={data.breakdown} raw={data.raw} truncated={data.truncated} />}
      </QueryState>
    </section>
  );
}

/** The three top-level regions of the request, as shares of its total bytes. */
function regionRows(b: RequestBreakdown): { label: string; bytes: number }[] {
  const messagesBytes = b.messages.reduce((n, m) => n + m.bytes, 0);
  return [
    { label: `Conversation (${b.messageCount} messages)`, bytes: messagesBytes },
    { label: `Tools (${b.toolCount} schemas)`, bytes: b.toolsBytes },
    { label: "System prompt", bytes: b.systemBytes },
  ].sort((a, c) => c.bytes - a.bytes);
}

function DetailBody({ file, breakdown: b, raw, truncated }: { file: string; breakdown: RequestBreakdown; raw: string; truncated: boolean }) {
  const regions = regionRows(b);
  const regionMax = Math.max(1, ...regions.map((r) => r.bytes));

  return (
    <>
      <div className="grid stats">
        <StatTile label="Total request" value={fmtBytes(b.totalBytes)} sub={`~${fmtInt(Math.round(b.totalBytes / 4))} tokens`} />
        <StatTile label="Conversation" value={String(b.messageCount)} sub="messages" />
        <StatTile label="Tools" value={String(b.toolCount)} sub={fmtBytes(b.toolsBytes)} />
        <StatTile label="System prompt" value={fmtBytes(b.systemBytes)} />
      </div>

      <div className="card">
        <h2>Why it was this large</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Region</th>
              <th className="num">Bytes</th>
              <th className="num">% of request</th>
              <th className="bar-col">Share</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{fmtBytes(r.bytes)}</td>
                <td className="num">{fmtPct(b.totalBytes > 0 ? (r.bytes / b.totalBytes) * 100 : 0, 1)}</td>
                <td className="bar-col">
                  <div className="rowbar" style={{ width: `${(r.bytes / regionMax) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid two">
        <MessagesTable file={file} messages={b.messages} />
        <ToolsTable file={file} tools={b.tools} />
      </div>

      <RawJson raw={raw} truncated={truncated} />
    </>
  );
}

type SortKey = "index" | "bytes" | "estTokens" | "share";
type SortDir = "asc" | "desc";

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  index: "asc",
  bytes: "desc",
  estTokens: "desc",
  share: "desc",
};

/** Share is drawn from bytes, so it sorts on the same underlying value. */
function sortValue(m: BreakdownMessage, key: SortKey): number {
  switch (key) {
    case "index":
      return m.index;
    case "estTokens":
      return m.estTokens;
    default:
      return m.bytes;
  }
}

function MessagesTable({ file, messages }: { file: string; messages: BreakdownMessage[] }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "index", dir: "asc" });
  const msgMax = Math.max(1, ...messages.map((m) => m.bytes));

  const sorted = useMemo(() => {
    const rows = [...messages];
    rows.sort((a, b) => {
      const diff = sortValue(a, sort.key) - sortValue(b, sort.key);
      return sort.dir === "asc" ? diff : -diff;
    });
    return rows;
  }, [messages, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className="card">
      <h2>Messages by size</h2>
      {messages.length === 0 ? (
        <div className="empty">No messages in this request.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <SortHeader label="#" sortKey="index" sort={sort} onSort={onSort} className="num" />
              <th>Role</th>
              <SortHeader label="Bytes" sortKey="bytes" sort={sort} onSort={onSort} className="num" />
              <SortHeader label="~Tokens" sortKey="estTokens" sort={sort} onSort={onSort} className="num" />
              <SortHeader label="Share" sortKey="share" sort={sort} onSort={onSort} className="bar-col" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr
                key={m.index}
                className="clickable"
                onClick={() =>
                  navigate({ to: "/context/$file/message/$index", params: { file, index: String(m.index) } })
                }
              >
                <td className="num">
                  <Link
                    to="/context/$file/message/$index"
                    params={{ file, index: String(m.index) }}
                    className="link"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {m.index}
                  </Link>
                </td>
                <td>{m.role}</td>
                <td className="num">{fmtBytes(m.bytes)}</td>
                <td className="num">{fmtInt(m.estTokens)}</td>
                <td className="bar-col">
                  <div className="rowbar" style={{ width: `${(m.bytes / msgMax) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ToolsTable({ file, tools }: { file: string; tools: BreakdownTool[] }) {
  const navigate = useNavigate();
  const toolMax = Math.max(1, ...tools.map((t) => t.bytes));

  return (
    <div className="card">
      <h2>Tools by size</h2>
      {tools.length === 0 ? (
        <div className="empty">No tools in this request.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Tool</th>
              <th className="num">Bytes</th>
              <th className="num">~Tokens</th>
              <th className="bar-col">Share</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr
                key={t.index}
                className="clickable"
                onClick={() =>
                  navigate({ to: "/context/$file/tool/$index", params: { file, index: String(t.index) } })
                }
              >
                <td>
                  <Link
                    to="/context/$file/tool/$index"
                    params={{ file, index: String(t.index) }}
                    className="link"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.name}
                  </Link>
                </td>
                <td className="num">{fmtBytes(t.bytes)}</td>
                <td className="num">{fmtInt(t.estTokens)}</td>
                <td className="bar-col">
                  <div className="rowbar" style={{ width: `${(t.bytes / toolMax) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={["sortable", className].filter(Boolean).join(" ")}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span className="sort-arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

function RawJson({ raw, truncated }: { raw: string; truncated: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Raw request JSON</h2>
        <button className="segmented" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {truncated && <div className="muted">Truncated to the first 2 MB.</div>}
      {open && <pre className="rawjson">{raw}</pre>}
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">{sub && <span className="muted">{sub}</span>}</div>
    </div>
  );
}
