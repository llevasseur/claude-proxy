import { Fragment, type ReactNode, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { MemoryDetail } from "../api";
import { getMemory } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtLocalTsShort } from "../format";

export function MemoryDetailPage() {
  const { project, name } = useParams({ from: "/projects/$project/memory/$name" });
  const query = useQuery({
    queryKey: ["memory", project, name],
    queryFn: () => getMemory(project, name),
  });
  const memory = query.data?.memory;

  return (
    <section>
      <div className="pagehead">
        <h1>{name}</h1>
        <Link to="/projects/$project" params={{ project }} className="link">
          ‹ back to memories
        </Link>
      </div>
      <div className="muted mono-break" style={{ marginBottom: "0.75rem" }}>
        {project}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {memory && <MemoryBody memory={memory} />}
      </QueryState>
    </section>
  );
}

function MemoryBody({ memory }: { memory: MemoryDetail }) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");
  const { frontmatter, body } = splitFrontmatter(memory.content);

  return (
    <>
      <div className="grid stats">
        <StatTile label="Size" value={fmtBytes(memory.bytes)} />
        <StatTile label="Modified" value={fmtLocalTsShort(memory.modified)} />
        {frontmatter?.type && <StatTile label="Type" value={frontmatter.type} />}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Memory</h2>
          <div className="segmented">
            <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>
              Pretty
            </button>
            <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
              Raw
            </button>
          </div>
        </div>
        {view === "pretty" ? (
          <div className="memory-pretty">
            {frontmatter && <Frontmatter fm={frontmatter} />}
            <Markdown source={body} />
          </div>
        ) : (
          <pre className="rawjson wrap">{memory.content}</pre>
        )}
      </div>
    </>
  );
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  /** All top-level scalar key: value pairs parsed. */
  fields: { key: string; value: string }[];
}

/**
 * Split a leading YAML-ish `--- … ---` frontmatter block off the body. Reads
 * only a shallow subset: top-level `key: value` plus a nested `metadata.type`.
 */
function splitFrontmatter(content: string): { frontmatter: ParsedFrontmatter | null; body: string } {
  const text = content.replace(/^﻿/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { frontmatter: null, body: text };

  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: text };

  const block = text.slice(text.indexOf("\n") + 1, end);
  const rest = text.slice(end + 4).replace(/^\r?\n/, "");

  const fields: { key: string; value: string }[] = [];
  let type: string | undefined;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1] ?? "";
    const key = m[2] ?? "";
    const clean = (m[3] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "type" && indent.length > 0) type = clean; // metadata.type
    if (indent.length === 0 && clean) fields.push({ key, value: clean });
  }

  const get = (k: string) => fields.find((f) => f.key === k)?.value;
  return {
    frontmatter: { name: get("name"), description: get("description"), type, fields },
    body: rest,
  };
}

function Frontmatter({ fm }: { fm: ParsedFrontmatter }) {
  const rows = fm.fields.filter((f) => f.value);
  if (rows.length === 0 && !fm.type) return null;
  return (
    <dl className="fm">
      {rows.map((f) => (
        <Fragment key={f.key}>
          <dt>{f.key}</dt>
          <dd>{f.value}</dd>
        </Fragment>
      ))}
      {fm.type && (
        <Fragment key="metadata.type">
          <dt>type</dt>
          <dd>{fm.type}</dd>
        </Fragment>
      )}
    </dl>
  );
}

/**
 * A small, dependency-free markdown renderer for the common subset memory files
 * use: headings, fenced code, blockquotes, unordered/ordered lists, horizontal
 * rules, and paragraphs — plus inline code, bold, italic, links, and Obsidian
 * `[[wikilinks]]`. Anything it doesn't recognise renders as a plain paragraph.
 */
function Markdown({ source }: { source: string }) {
  const lines = source.split("\n");
  const at = (n: number): string => lines[n] ?? "";
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = at(i);

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(at(i))) {
        buf.push(at(i));
        i += 1;
      }
      i += 1; // closing fence
      out.push(
        <pre key={key++} className="rawjson wrap">
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="md-hr" />);
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const Tag = `h${Math.min(level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";
      out.push(
        <Tag key={key++} className="md-h">
          {renderInline(heading[2] ?? "")}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(at(i))) {
        buf.push(at(i).replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(buf.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    const ordered = /^\s*\d+\.\s+/.test(line);
    const unordered = /^\s*[-*+]\s+/.test(line);
    if (ordered || unordered) {
      const items: string[] = [];
      const isItem = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && isItem.test(at(i))) {
        items.push(at(i).replace(isItem, ""));
        i += 1;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++} className="md-list">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && at(i).trim() !== "" && !/^```/.test(at(i))) {
      buf.push(at(i));
      i += 1;
    }
    out.push(
      <p key={key++} className="md-p">
        {renderInline(buf.join("\n"))}
      </p>,
    );
  }

  return <>{out}</>;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)\s]+\))/g;

/** Tokenise a run of text into inline React nodes. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(<code key={key++} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("[[")) {
      nodes.push(<code key={key++} className="md-wikilink">{tok.slice(2, -2)}</code>);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (linkMatch) {
        nodes.push(
          <a key={key++} className="link" href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(tok);
      }
    }
    last = idx + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
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
