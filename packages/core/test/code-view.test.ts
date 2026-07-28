import { describe, expect, it } from "vitest";
import {
  codeSyntax,
  formatJsonText,
  highlightSource,
  prettifyLog,
  stripAnsi,
  type CodeSyntax,
  type CodeTokenKind,
} from "../src/code-view.js";

const ESC = "\u001B";
const BEL = "\u0007";

describe("stripAnsi", () => {
  it("removes colour codes, leaving the text", () => {
    expect(stripAnsi(`${ESC}[32m+${ESC}[39m done`)).toBe("+ done");
  });

  it("removes an OSC title sequence", () => {
    expect(stripAnsi(`${ESC}]0;a title${BEL}text`)).toBe("text");
  });

  it("leaves text with no escapes untouched", () => {
    expect(stripAnsi("plain output")).toBe("plain output");
  });
});

describe("prettifyLog", () => {
  it("keeps only the frame a carriage-return spinner left on screen", () => {
    expect(prettifyLog("Progress: 1\rProgress: 2\rProgress: 3")).toBe("Progress: 3");
  });

  it("resolves each line independently and strips escapes as it goes", () => {
    const input = `a\rb\n${ESC}[36mc${ESC}[39m\rd`;
    expect(prettifyLog(input)).toBe("b\nd");
  });

  it("leaves a clean log alone", () => {
    expect(prettifyLog("one\ntwo")).toBe("one\ntwo");
  });
});

describe("formatJsonText", () => {
  it("re-indents at two spaces", () => {
    expect(formatJsonText('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', ok: true });
  });

  it("echoes the input and reports failure when it doesn't parse", () => {
    const half = '{"state":"wor';
    expect(formatJsonText(half)).toEqual({ text: half, ok: false });
  });
});

describe("codeSyntax", () => {
  it("picks the convention family from the extension", () => {
    expect(codeSyntax("check.mjs")).toBe("c-like");
    expect(codeSyntax("app.tsx")).toBe("c-like");
    expect(codeSyntax("state.json")).toBe("json");
    expect(codeSyntax("run.sh")).toBe("hash");
    expect(codeSyntax("conf.yml")).toBe("hash");
  });

  it("falls back to plain for an unknown or absent extension", () => {
    expect(codeSyntax("sb.log")).toBe("plain");
    expect(codeSyntax("Makefile")).toBe("plain");
  });
});

/** Flatten a highlight to `kind:text` pairs for one line, dropping whitespace-only text. */
function tokensOf(source: string, syntax: CodeSyntax, line = 0): [CodeTokenKind, string][] {
  const lines = highlightSource(source, syntax);
  return (lines[line] ?? [])
    .filter((t) => !(t.kind === "text" && t.text.trim() === ""))
    .map((t) => [t.kind, t.text]);
}

describe("highlightSource", () => {
  it("colours keywords, strings and numbers in c-like source", () => {
    // Adjacent runs of the same kind coalesce, so ` a = ` is one text token.
    expect(tokensOf('const a = "x";', "c-like")).toEqual([
      ["keyword", "const"],
      ["text", " a = "],
      ["string", '"x"'],
      ["text", ";"],
    ]);
    expect(tokensOf("let n = 42;", "c-like")).toContainEqual(["number", "42"]);
  });

  it("colours a line comment to the end of its line only", () => {
    const lines = highlightSource("// note\ncode", "c-like");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([{ kind: "comment", text: "// note" }]);
    expect(lines[1]?.[0]?.kind).toBe("text");
  });

  it("spans a block comment across the lines it covers", () => {
    const lines = highlightSource("/* a\nb */ x", "c-like");
    expect(lines[0]).toEqual([{ kind: "comment", text: "/* a" }]);
    expect(lines[1]?.[0]).toEqual({ kind: "comment", text: "b */" });
  });

  it("treats # as a comment in hash syntax, but not inside a word", () => {
    expect(tokensOf("# note", "hash")).toEqual([["comment", "# note"]]);
    expect(tokensOf("echo $# done", "hash")).not.toContainEqual(["comment", "# done"]);
  });

  it("does not treat // as a comment outside c-like syntax", () => {
    expect(tokensOf("a // b", "hash").some(([kind]) => kind === "comment")).toBe(false);
  });

  it("marks a JSON key apart from its value", () => {
    expect(tokensOf('{"state": "working"}', "json")).toEqual([
      ["text", "{"],
      ["key", '"state"'],
      ["text", ": "],
      ["string", '"working"'],
      ["text", "}"],
    ]);
  });

  it("colours JSON literals as keywords", () => {
    expect(tokensOf('{"a": null, "b": true}', "json")).toContainEqual(["keyword", "null"]);
  });

  it("ends an unterminated quote at its newline rather than swallowing the file", () => {
    const lines = highlightSource("say 'oops\nconst a = 1;", "c-like");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.some((t) => t.kind === "string")).toBe(true);
    // The next line recovers: `const` is still a keyword, not string content.
    expect(lines[1]?.[0]).toEqual({ kind: "keyword", text: "const" });
  });

  it("lets a back-tick template span lines", () => {
    const lines = highlightSource("const a = `one\ntwo`;", "c-like");
    expect(lines[1]?.[0]?.kind).toBe("string");
  });

  it("honours escaped quotes inside a string", () => {
    expect(tokensOf('a = "he said \\"hi\\"" ;', "c-like")).toContainEqual(["string", '"he said \\"hi\\""']);
  });

  it("always returns one entry per source line, so numbering matches", () => {
    expect(highlightSource("a\nb\n\nc", "plain")).toHaveLength(4);
    expect(highlightSource("", "plain")).toHaveLength(1);
  });

  it("leaves plain syntax's identifiers uncoloured", () => {
    expect(tokensOf("const a = 1", "plain").some(([kind]) => kind === "keyword")).toBe(false);
  });
});
