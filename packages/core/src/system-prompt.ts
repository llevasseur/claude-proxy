/**
 * The device system prompt — `~/.claude/CLAUDE.md`, the instruction file every
 * Claude Code session on this machine loads into its system prompt.
 *
 * Device view, not traffic: the proxy never records the system prompt, so the file
 * on disk is the only readable copy.
 *
 * Pure: shaping text into an outline, sizing it, and validating a proposed
 * replacement. Reading and writing the file is the server's job.
 */
import { estTokens } from "./context.js";

/** One `#`-heading in the prompt, with the span of text it owns. */
export interface SystemPromptSection {
  /** Heading text, without the leading `#`s. */
  heading: string;
  /** Heading depth, 1–6. */
  level: number;
  /** 1-based line the heading sits on. */
  line: number;
  /** Bytes from this heading up to the next heading at any level (or EOF). */
  bytes: number;
}

/** The file, as the dashboard sees it. */
export interface SystemPromptDoc {
  /** Absolute path the server read (or would create). */
  path: string;
  /** False when nothing is there yet — saving creates it. */
  exists: boolean;
  /** Full text. Empty when the file is absent. */
  text: string;
  bytes: number;
  /** Rough token cost this adds to *every* request on the device. */
  estTokens: number;
  /** Line count; 0 for an empty/absent file. */
  lines: number;
  /** Heading outline, in document order. */
  sections: SystemPromptSection[];
  /** ISO mtime, or null when absent. */
  modified: string | null;
}

/**
 * Ceiling on a saved prompt. Well under the server's 1 MB body limit, and far past
 * anything a useful instruction file reaches.
 */
export const SYSTEM_PROMPT_MAX_BYTES = 200_000;

/** UTF-8 size of a string — the unit the file is measured in. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Heading outline of a markdown document. Lines inside a fenced code block are
 * skipped — a shell comment (`# do the thing`) is not a section.
 */
export function outlineSystemPrompt(text: string): SystemPromptSection[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const found: { heading: string; level: number; line: number; offset: number }[] = [];
  let fence: string | null = null;
  let offset = 0;

  lines.forEach((line, i) => {
    const opener = FENCE_RE.exec(line);
    if (fence) {
      if (opener && opener[1] === fence) fence = null;
    } else if (opener) {
      fence = opener[1]!;
    } else {
      const heading = HEADING_RE.exec(line);
      if (heading) {
        found.push({ heading: heading[2]!, level: heading[1]!.length, line: i + 1, offset });
      }
    }
    offset += utf8Bytes(line) + 1; // the newline this split consumed
  });

  const total = utf8Bytes(text);
  return found.map((h, i) => ({
    heading: h.heading,
    level: h.level,
    line: h.line,
    bytes: (found[i + 1]?.offset ?? total) - h.offset,
  }));
}

/**
 * Lines in a document. The newline every saved prompt closes with ends the last
 * line rather than starting another.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
}

/** Shape a file's text (and metadata) into the document the dashboard renders. */
export function summarizeSystemPrompt(input: {
  path: string;
  exists: boolean;
  text: string;
  modified: string | null;
}): SystemPromptDoc {
  const bytes = utf8Bytes(input.text);
  return {
    path: input.path,
    exists: input.exists,
    text: input.text,
    bytes,
    estTokens: estTokens(bytes),
    lines: countLines(input.text),
    sections: outlineSystemPrompt(input.text),
    modified: input.modified,
  };
}

/**
 * Canonical on-disk form of an edited prompt: LF line endings, no trailing blank
 * lines, and exactly one closing newline — a browser textarea introduces all three.
 */
export function normalizeSystemPromptText(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return body === "" ? "" : `${body}\n`;
}

/**
 * Validate a proposed replacement and return its canonical form. Throws on a
 * non-string or anything past the ceiling — the route maps that to a 400.
 */
export function parseSystemPromptText(value: unknown): string {
  if (typeof value !== "string") throw new Error("system prompt text must be a string");
  const normalized = normalizeSystemPromptText(value);
  const bytes = utf8Bytes(normalized);
  if (bytes > SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(`system prompt text larger than ${SYSTEM_PROMPT_MAX_BYTES} bytes: ${bytes}`);
  }
  return normalized;
}
