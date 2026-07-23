import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { RequestMessageDetail } from "@claude-proxy/core";
import { getContextMessage } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt } from "../format";

export function ContextMessagePage() {
  const { file, index } = useParams({ from: "/context/$file/message/$index" });
  const idx = Number(index);
  const query = useQuery({
    queryKey: ["context-message", file, idx],
    queryFn: () => getContextMessage(file, idx),
  });
  const message = query.data?.message;

  return (
    <section>
      <div className="pagehead">
        <h1>Message #{index}</h1>
        <Link to="/context/$file" params={{ file }} className="link">
          ‹ back to breakdown
        </Link>
      </div>
      <div className="muted" style={{ marginBottom: "0.75rem", wordBreak: "break-all" }}>{file}</div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {message && <MessageBody file={file} message={message} />}
      </QueryState>
    </section>
  );
}

function MessageBody({ file, message: m }: { file: string; message: RequestMessageDetail }) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");

  return (
    <>
      <MessagePager file={file} index={m.index} messageCount={m.messageCount} />

      <div className="grid stats">
        <StatTile label="Position" value={`#${m.index}`} sub={`of ${m.messageCount} messages`} />
        <StatTile label="Role" value={m.role} />
        <StatTile label="Size" value={fmtBytes(m.bytes)} sub={`~${fmtInt(m.estTokens)} tokens`} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Full message</h2>
          <div className="segmented">
            <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>
              Pretty
            </button>
            <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
              Raw
            </button>
          </div>
        </div>
        {view === "pretty" ? <PrettyMessage content={m.content} /> : <pre className="rawjson wrap">{m.content}</pre>}
      </div>
    </>
  );
}

/** Previous/Next navigation between adjacent messages in the same request. */
function MessagePager({ file, index, messageCount }: { file: string; index: number; messageCount: number }) {
  const hasPrev = index > 0;
  const hasNext = index < messageCount - 1;

  return (
    <nav className="pager" aria-label="Message navigation">
      {hasPrev ? (
        <Link
          to="/context/$file/message/$index"
          params={{ file, index: String(index - 1) }}
          className="pager-btn"
        >
          ‹ Previous
        </Link>
      ) : (
        <button className="pager-btn" disabled>
          ‹ Previous
        </button>
      )}

      <span className="pager-pos muted">
        #{index} of {messageCount}
      </span>

      {hasNext ? (
        <Link
          to="/context/$file/message/$index"
          params={{ file, index: String(index + 1) }}
          className="pager-btn"
        >
          Next ›
        </Link>
      ) : (
        <button className="pager-btn" disabled>
          Next ›
        </button>
      )}
    </nav>
  );
}

/** A single content block, loosely typed since request bodies are untrusted. */
type Block = Record<string, unknown>;

/**
 * Render the stored message JSON as readable content blocks, dropping transport
 * noise (cache_control, thinking signatures, base64 image bytes). Falls back to
 * raw JSON on an unexpected shape.
 */
function PrettyMessage({ content }: { content: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return <pre className="rawjson wrap">{content}</pre>;
  }

  const blocks = toBlocks((parsed as { content?: unknown } | null)?.content);
  if (blocks.length === 0) return <pre className="rawjson wrap">{content}</pre>;

  return (
    <div className="msg-blocks">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

/** Normalise a message's `content` into an array of blocks. */
function toBlocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? { type: "text", text: b } : (b as Block)));
  return [];
}

function BlockView({ block }: { block: Block }) {
  const type = typeof block.type === "string" ? block.type : "unknown";

  switch (type) {
    case "text":
      return <Section label="Text"><Prose text={str(block.text)} /></Section>;

    case "thinking":
      return <Section label="Thinking"><Prose text={str(block.thinking)} /></Section>;

    case "tool_use":
      return (
        <Section label={`Tool call · ${str(block.name) || "unknown"}`}>
          <pre className="rawjson wrap">{stringify(block.input)}</pre>
        </Section>
      );

    case "tool_result": {
      const error = block.is_error === true;
      return (
        <Section label="Tool result" badge={error ? "error" : undefined}>
          {toBlocks(block.content).map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </Section>
      );
    }

    case "image": {
      const src = (block.source ?? {}) as Block;
      const media = str(src.media_type) || "image";
      const bytes = typeof src.data === "string" ? Math.floor((src.data.length * 3) / 4) : 0;
      return (
        <Section label="Image">
          <div className="muted">{media}{bytes ? ` · ~${fmtBytes(bytes)} (data omitted)` : ""}</div>
        </Section>
      );
    }

    default:
      return (
        <Section label={type}>
          <pre className="rawjson wrap">{stringify(block)}</pre>
        </Section>
      );
  }
}

function Section({ label, badge, children }: { label: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="msg-block">
      <div className="msg-block-head">
        <span className="msg-block-label">{label}</span>
        {badge && <span className="msg-badge">{badge}</span>}
      </div>
      {children}
    </div>
  );
}

/** Wrapped, newline-preserving prose for text-ish values. */
function Prose({ text }: { text: string }) {
  return <div className="msg-text">{text}</div>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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
