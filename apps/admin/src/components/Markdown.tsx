import type { ReactNode } from "react";

/**
 * A small, dependency-free markdown renderer for the common subset the memory
 * files and session transcripts use: headings, fenced code, blockquotes,
 * unordered/ordered lists, horizontal rules, and paragraphs — plus inline code,
 * bold, italic, links, and Obsidian `[[wikilinks]]`. Anything it doesn't
 * recognise renders as a plain paragraph.
 */
export function Markdown({ source }: { source: string }) {
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
            // A `✗ …` item is a transcript error.
            <li key={n} className={/^✗\s/.test(it) ? "md-error" : undefined}>
              {renderInline(it)}
            </li>
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
