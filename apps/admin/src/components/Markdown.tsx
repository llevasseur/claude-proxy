import type { ReactNode } from 'react';

/** An HTML comment kept to one line — an include directive in the command files. */
const COMMENT_RE = /<!--.*?-->/g;

/**
 * A small, dependency-free markdown renderer for the common subset the memory
 * files, command files and session transcripts use: headings, fenced code,
 * blockquotes, nested unordered/ordered lists, horizontal rules, and paragraphs
 * — plus inline code, bold, italic, links, and Obsidian `[[wikilinks]]`.
 * Anything it doesn't recognise renders as a plain paragraph. HTML comments are
 * dropped everywhere but inside a fence.
 */
export function Markdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const raw = (n: number): string => lines[n] ?? '';
  const at = (n: number): string => raw(n).replace(COMMENT_RE, '');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = at(i);

    const fence = /^```(.*)$/.exec(raw(i));
    if (fence) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(raw(i))) {
        buf.push(raw(i));
        i += 1;
      }
      i += 1; // closing fence
      out.push(
        <pre key={key++} className='rawjson wrap'>
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }

    // A comment that spans lines survives the per-line strip above; skip it whole.
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(at(i))) i += 1;
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className='md-hr' />);
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      const Tag = `h${Math.min(level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      out.push(
        <Tag key={key++} className='md-h'>
          {renderInline(heading[2] ?? '')}
        </Tag>,
      );
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(at(i))) {
        buf.push(at(i).replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(
        <blockquote key={key++} className='md-quote'>
          {renderInline(buf.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    if (ITEM_RE.test(line)) {
      const flat: FlatItem[] = [];
      while (i < lines.length) {
        const item = ITEM_RE.exec(at(i));
        if (item) {
          flat.push({
            indent: (item[1] ?? '').length,
            ordered: /\d/.test(item[2] ?? ''),
            text: item[3] ?? '',
          });
          i += 1;
          continue;
        }
        // An indented line that isn't an item continues the one above it.
        const next = at(i);
        const last = flat[flat.length - 1];
        if (last && next.trim() !== '' && /^\s/.test(next) && !/^\s*```/.test(raw(i))) {
          last.text = `${last.text} ${next.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push(renderList(nest(flat), key++));
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && at(i).trim() !== '' && !/^```/.test(raw(i))) {
      buf.push(at(i));
      i += 1;
    }
    out.push(
      <p key={key++} className='md-p'>
        {renderInline(buf.join('\n'))}
      </p>,
    );
  }

  return <>{out}</>;
}

/** A list item: its indentation, its marker, and the text after it. */
const ITEM_RE = /^(\s*)(\d+\.|[-*+])\s+(.*)$/;

interface FlatItem {
  indent: number;
  ordered: boolean;
  text: string;
}

/** One item of a list, carrying whatever list is nested under it. */
interface ListNode {
  text: string;
  ordered: boolean;
  children: ListNode[];
}

/**
 * Turn a run of list lines into a tree by indentation. Depth is relative — any item
 * indented further than the one above nests under it, whatever the file's step.
 */
function nest(items: readonly FlatItem[]): ListNode[] {
  const roots: ListNode[] = [];
  const open: { indent: number; node: ListNode }[] = [];
  for (const item of items) {
    const node: ListNode = { text: item.text, ordered: item.ordered, children: [] };
    while (open.length > 0 && item.indent <= open[open.length - 1]!.indent) open.pop();
    const parent = open[open.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    open.push({ indent: item.indent, node });
  }
  return roots;
}

/** Render one level of the tree; the first item's marker decides `ol` or `ul`. */
function renderList(nodes: readonly ListNode[], key?: number): ReactNode {
  const List = nodes[0]?.ordered ? 'ol' : 'ul';
  return (
    <List key={key} className='md-list'>
      {nodes.map((node, n) => (
        // A `✗ …` item is a transcript error.
        // biome-ignore lint/suspicious/noArrayIndexKey: list items come straight off the parsed source in order
        <li key={n} className={/^✗\s/.test(node.text) ? 'md-error' : undefined}>
          {renderInline(node.text)}
          {node.children.length > 0 && renderList(node.children)}
        </li>
      ))}
    </List>
  );
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
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={key++} className='md-code'>
          {tok.slice(1, -1)}
        </code>,
      );
      // Emphasis re-enters the tokeniser below — these files put code spans inside bold runs.
    } else if (tok.startsWith('**')) {
      nodes.push(<strong key={key++}>{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith('*')) {
      nodes.push(<em key={key++}>{renderInline(tok.slice(1, -1))}</em>);
    } else if (tok.startsWith('[[')) {
      nodes.push(
        <code key={key++} className='md-wikilink'>
          {tok.slice(2, -2)}
        </code>,
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (linkMatch) {
        nodes.push(
          <a key={key++} className='link' href={linkMatch[2]} target='_blank' rel='noreferrer'>
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
