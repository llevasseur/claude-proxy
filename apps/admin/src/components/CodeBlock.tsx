import { useMemo } from "react";
import { highlightSource, type CodeSyntax } from "@claude-proxy/core";

/** Lines rendered before the block gives up and points at the Raw view instead.
 * A capped job file is half a megabyte, which can be 15k lines — enough to cost a
 * visible pause on every re-render for a view nobody scrolls to the end of. */
const MAX_LINES = 3000;

export interface CodeBlockProps {
  source: string;
  /** Comment/string conventions to colour by; `plain` is strings and numbers only. */
  syntax: CodeSyntax;
  /** Soft-wrap long lines instead of scrolling horizontally — right for prose and
   * logs, wrong for code, where a wrapped line breaks the column alignment. */
  wrap?: boolean;
}

/**
 * A syntax-coloured, line-numbered source view — the "pretty" half of the file
 * viewer. Numbers come from a CSS counter rather than the markup, so selecting the
 * block copies the code without them.
 */
export function CodeBlock({ source, syntax, wrap = false }: CodeBlockProps) {
  const all = useMemo(() => highlightSource(source, syntax), [source, syntax]);
  const lines = all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all;

  return (
    <>
      <ol className={`codeblock${wrap ? " wrap" : ""}`}>
        {lines.map((tokens, n) => (
          // The index *is* the line number, and lines never reorder.
          <li key={n}>
            {tokens.map((token, i) =>
              token.kind === "text" ? (
                token.text
              ) : (
                <span key={i} className={`tok-${token.kind}`}>
                  {token.text}
                </span>
              ),
            )}
          </li>
        ))}
      </ol>
      {all.length > MAX_LINES && (
        <div className="leak-note" style={{ marginTop: 8 }}>
          Showing the first {MAX_LINES.toLocaleString()} of {all.length.toLocaleString()} lines — switch to{" "}
          <strong>Raw</strong> for the whole file.
        </div>
      )}
    </>
  );
}
