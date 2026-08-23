import type { ReactNode } from "react";

// Message-body rendering (`components/Markdown.tsx`, `CodeBlock.tsx` at the
// pinned commit), reduced to what captured Responses text needs: paragraphs
// split on blank lines, fenced code blocks, and inline `code` spans. No HTML
// is ever injected — every piece is a React node.

export function CodeBlock({ code }: { readonly code: string }) {
  return (
    <pre className="car-cell-mono code-block" data-testid="code-block">
      <code>{code}</code>
    </pre>
  );
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on single-backtick spans; an unmatched backtick renders literally.
  if (((text.match(/`/g) ?? []).length & 1) === 1) return [text];
  let codeSpan = 0;
  text.split("`").forEach((part, index) => {
    if (index % 2 === 1) {
      const key = `${keyPrefix}-code-${codeSpan++}`;
      nodes.push(
        part.length > 0 ? (
          <code key={key} className="inline-code">
            {part}
          </code>
        ) : null,
      );
    } else if (part.length > 0) {
      nodes.push(part);
    }
  });
  return nodes;
}

export function MarkdownText({ text }: { readonly text: string }) {
  const blocks: ReactNode[] = [];
  let blockCount = 0;
  const nextBlockKey = (prefix: string) => `${prefix}-${blockCount++}`;
  text.split(/```/).forEach((segment, segmentIndex) => {
    if (segmentIndex % 2 === 1) {
      // Fenced block: drop a leading language line when present.
      const body = segment.replace(/^[a-zA-Z0-9_-]*\n/, "");
      blocks.push(<CodeBlock key={nextBlockKey("code")} code={body.replace(/\n$/, "")} />);
      return;
    }
    for (const paragraph of segment.split(/\n{2,}/)) {
      const trimmed = paragraph.trim();
      if (trimmed.length === 0) continue;
      const key = nextBlockKey("p");
      blocks.push(
        <p key={key} className="message-paragraph">
          {inline(trimmed, key)}
        </p>,
      );
    }
  });
  return (
    <div className="markdown-text" data-testid="markdown-text">
      {blocks}
    </div>
  );
}
