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
import { estTokens } from './context.js';
import { jsonText, jsonValueOf } from './json.js';

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
  if (text === '') return [];
  const lines = text.split('\n');
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
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
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
  const body = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return body === '' ? '' : `${body}\n`;
}

/**
 * Validate a proposed replacement and return its canonical form. Throws on a
 * non-string or anything past the ceiling — the route maps that to a 400.
 */
export function parseSystemPromptText<Candidate>(value: Candidate): string {
  const text = jsonText(jsonValueOf(value));
  if (text === null) throw new Error('system prompt text must be a string');
  const normalized = normalizeSystemPromptText(text);
  const bytes = utf8Bytes(normalized);
  if (bytes > SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error(`system prompt text larger than ${SYSTEM_PROMPT_MAX_BYTES} bytes: ${bytes}`);
  }
  return normalized;
}

/**
 * The `modified` a save claims to be replacing — the mtime the editor last read.
 * Absent means "write regardless", which is what a caller that never read the file
 * sends; `null` is the legitimate value for "there was no file".
 */
export function parseSystemPromptExpectedModified<Candidate>(value: Candidate): string | null | undefined {
  if (value === undefined) return undefined;
  const parsed = jsonValueOf(value);
  if (parsed === null) return null;
  const text = jsonText(parsed);
  if (text === null) throw new Error('system prompt expectedModified must be a string or null');
  return text;
}

/** One rendered line of a save diff. `text` carries its own ` `/`+`/`-` marker. */
export type SystemPromptDiffKind = 'context' | 'added' | 'removed' | 'gap';

export interface SystemPromptDiffLine {
  kind: SystemPromptDiffKind;
  /** Marker-prefixed line, or the `@@ … @@` header for a `gap`. */
  text: string;
}

export interface SystemPromptDiff {
  /** Changed regions with a few lines of context; empty when nothing differs. */
  lines: SystemPromptDiffLine[];
  added: number;
  removed: number;
  /** The two texts are byte-identical — a save would write nothing new. */
  identical: boolean;
  /** The change was too large to line up, so it reads as a whole-file replacement. */
  wholeFile: boolean;
}

/** Unchanged lines kept either side of a change, as `diff -u` does. */
const DIFF_CONTEXT = 3;

/**
 * Cells the alignment table may fill. Past this the diff degrades to a whole-file
 * replacement instead of allocating for it.
 */
const DIFF_MAX_CELLS = 4_000_000;

/**
 * Lines of a document for diffing. The newline a saved prompt closes with ends the
 * last line rather than opening an empty one, matching {@link countLines}.
 */
function diffLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

type DiffOp = { kind: 'equal' | 'added' | 'removed'; text: string };

/** Every old line dropped, every new line written — the shape of a replacement. */
function replaceAll(before: string[], after: string[]): DiffOp[] {
  return [
    ...before.map((text): DiffOp => ({ kind: 'removed', text })),
    ...after.map((text): DiffOp => ({ kind: 'added', text })),
  ];
}

/**
 * Longest-common-subsequence alignment of two line arrays. The caller has already
 * trimmed the matching head and tail, so this sees the changed region alone.
 */
function alignLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0) return replaceAll(before, after);

  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        before[i] === after[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'equal', text: before[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: 'removed', text: before[i]! });
      i++;
    } else {
      ops.push({ kind: 'added', text: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'removed', text: before[i++]! });
  while (j < m) ops.push({ kind: 'added', text: after[j++]! });
  return ops;
}

const MARKERS = { equal: ' ', added: '+', removed: '-' } satisfies Record<DiffOp['kind'], string>;

/**
 * A unified line diff of `before` against `after`, ready to render as text.
 *
 * `before` is the bytes read back off disk at confirm time and `after` the
 * normalized draft about to land, so the diff describes the write itself rather
 * than the state the page happened to load with.
 */
export function diffSystemPromptText(before: string, after: string): SystemPromptDiff {
  if (before === after) return { lines: [], added: 0, removed: 0, identical: true, wholeFile: false };

  const a = diffLines(before);
  const b = diffLines(after);

  // A long instruction file usually changes in one place, so only the middle is aligned.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const wholeFile = midA.length * midB.length > DIFF_MAX_CELLS;

  const ops: DiffOp[] = [
    ...a.slice(0, head).map((text): DiffOp => ({ kind: 'equal', text })),
    ...(wholeFile ? replaceAll(midA, midB) : alignLines(midA, midB)),
    ...a.slice(a.length - tail).map((text): DiffOp => ({ kind: 'equal', text })),
  ];

  // Line numbers each op sits on, so the hunk headers can name real positions.
  let oldLine = 0;
  let newLine = 0;
  const rows = ops.map((op) => {
    if (op.kind !== 'added') oldLine++;
    if (op.kind !== 'removed') newLine++;
    return { op, oldLine, newLine };
  });

  const ranges: [number, number][] = [];
  rows.forEach((row, i) => {
    if (row.op.kind === 'equal') return;
    const start = Math.max(0, i - DIFF_CONTEXT);
    const end = Math.min(rows.length, i + DIFF_CONTEXT + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });

  const lines: SystemPromptDiffLine[] = [];
  for (const [start, end] of ranges) {
    const span = rows.slice(start, end);
    const oldCount = span.filter((r) => r.op.kind !== 'added').length;
    const newCount = span.filter((r) => r.op.kind !== 'removed').length;
    const oldStart = span.find((r) => r.op.kind !== 'added')?.oldLine ?? 0;
    const newStart = span.find((r) => r.op.kind !== 'removed')?.newLine ?? 0;
    lines.push({ kind: 'gap', text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` });
    for (const { op } of span) {
      lines.push({
        kind: op.kind === 'equal' ? 'context' : op.kind,
        text: `${MARKERS[op.kind]}${op.text}`,
      });
    }
  }

  return {
    lines,
    added: ops.filter((op) => op.kind === 'added').length,
    removed: ops.filter((op) => op.kind === 'removed').length,
    identical: false,
    wholeFile,
  };
}
