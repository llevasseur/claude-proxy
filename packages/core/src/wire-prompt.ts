/**
 * The system prompt as it goes over the wire — the request's `system` field,
 * not the device `CLAUDE.md` that `system-prompt.ts` covers. One is the file on
 * disk; this is what Anthropic was actually sent, which includes it and much
 * else besides.
 *
 * Pure: shaping a captured `system` field into an outline, and diffing two
 * outlines. Hashing and file I/O belong to the proxy and the server.
 */

/** UTF-8 byte length of a value's JSON form — matches the proxy's `Buffer.byteLength`. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** UTF-8 byte length of raw text. */
function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One `#`-heading span inside a block, or the text before the first heading. */
export interface WirePromptSection {
  /** Index of the block this span belongs to. */
  block: number;
  /** Heading line without its `#`s, or `"(preamble)"` for text before the first. */
  heading: string;
  /** Heading depth 1–6; 0 for a preamble. */
  level: number;
  /** Raw UTF-8 bytes from this heading up to the next one at any level. */
  bytes: number;
}

/** One top-level entry of the `system` array (a bare string counts as one). */
export interface WirePromptBlock {
  index: number;
  /** JSON-serialized bytes — the unit `systemBytes` is counted in. */
  bytes: number;
  /** Raw text bytes, which is what the sections sum to. */
  textBytes: number;
  /** `cache_control.ttl` when the block carries one. */
  cacheTtl: string | null;
}

/**
 * A captured system prompt, decomposed. `bytes` is the same number the digest
 * averages, so an outline always reconciles with `avgSystemPromptBytes`.
 *
 * Section bytes are raw text and block bytes are JSON, so sections sum to each
 * block's `textBytes` rather than its `bytes` — JSON escaping and the
 * `{"type":"text",…}` envelope live in the difference.
 */
export interface WirePromptOutline {
  /** Total JSON bytes of the whole `system` field. */
  bytes: number;
  blocks: WirePromptBlock[];
  sections: WirePromptSection[];
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** Name given to the span before a block's first heading. */
export const PREAMBLE = "(preamble)";

/**
 * Split one block's text into heading spans. Lines inside a fenced code block
 * are skipped, so a shell comment is not a section. Mirrored in
 * `proxy/system-prompt.mjs`; the two are held together by
 * `server/test/wire-prompt-parity.test.ts`.
 */
export function sectionsOfText(text: string, block: number): WirePromptSection[] {
  const lines = text.split("\n");
  const found: { heading: string; level: number; offset: number }[] = [];
  let fence: string | null = null;
  let offset = 0;

  for (const line of lines) {
    const opener = FENCE_RE.exec(line);
    if (fence) {
      if (opener && opener[1] === fence) fence = null;
    } else if (opener) {
      fence = opener[1]!;
    } else {
      const heading = HEADING_RE.exec(line);
      if (heading) found.push({ heading: heading[2]!, level: heading[1]!.length, offset });
    }
    offset += textBytes(line) + 1; // the newline this split consumed
  }

  const total = textBytes(text);
  const out: WirePromptSection[] = [];
  // Text before the first heading is still bytes on the wire, so it gets a row.
  const firstOffset = found[0]?.offset ?? total;
  if (firstOffset > 0) out.push({ block, heading: PREAMBLE, level: 0, bytes: firstOffset });
  found.forEach((h, i) => {
    out.push({ block, heading: h.heading, level: h.level, bytes: (found[i + 1]?.offset ?? total) - h.offset });
  });
  return out;
}

/** Text of one `system` entry, for the shapes the API accepts. */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (typeof block === "object" && block !== null) {
    const t = (block as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function blockCacheTtl(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const cc = (block as { cache_control?: unknown }).cache_control;
  if (typeof cc !== "object" || cc === null) return null;
  const ttl = (cc as { ttl?: unknown }).ttl;
  return typeof ttl === "string" ? ttl : "ephemeral";
}

/**
 * Decompose a captured `system` field. Tolerant of every shape the API accepts
 * — absent, a bare string, or an array of blocks — and of malformed ones, which
 * yield zeros rather than throwing.
 */
export function outlineWirePrompt(system: unknown): WirePromptOutline {
  if (system === undefined || system === null) return { bytes: 0, blocks: [], sections: [] };

  const raw = Array.isArray(system) ? system : [system];
  const blocks: WirePromptBlock[] = [];
  const sections: WirePromptSection[] = [];

  raw.forEach((block, index) => {
    const text = blockText(block);
    blocks.push({
      index,
      bytes: jsonBytes(block),
      textBytes: textBytes(text),
      cacheTtl: blockCacheTtl(block),
    });
    if (text !== "") sections.push(...sectionsOfText(text, index));
  });

  return { bytes: jsonBytes(system), blocks, sections };
}

/**
 * One outline as `logs/system-prompts/<hash>.json` holds it — written once per
 * distinct prompt, so it outlives the request bodies it was derived from.
 */
export interface StoredWirePrompt extends WirePromptOutline {
  hash: string;
  /** When the prompt was first recorded, not when a request last used it. */
  firstSeen: string;
}

/** Structural guard for a parsed-but-untrusted store record. */
export function isStoredWirePrompt(value: unknown): value is StoredWirePrompt {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.hash === "string" && typeof v.bytes === "number" && Array.isArray(v.blocks) && Array.isArray(v.sections);
}

/** One section's movement between two versions of a prompt. */
export interface SectionMove {
  heading: string;
  /** Bytes now; 0 when the section was dropped. */
  bytes: number;
  /** Bytes before; 0 when the section is new. */
  priorBytes: number;
  deltaBytes: number;
  status: "added" | "removed" | "grew" | "shrank" | "same";
}

/** Sum sections by heading, so a heading repeated across blocks reads as one row. */
function byHeading(sections: readonly WirePromptSection[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sections) out.set(s.heading, (out.get(s.heading) ?? 0) + s.bytes);
  return out;
}

/**
 * Section-by-section difference between two prompt versions, biggest absolute
 * move first. This is the answer to "what actually changed" once a prompt's
 * hash moves.
 */
export function diffWirePrompts(
  prior: Pick<WirePromptOutline, "sections">,
  current: Pick<WirePromptOutline, "sections">,
): SectionMove[] {
  const before = byHeading(prior.sections);
  const after = byHeading(current.sections);

  const moves: SectionMove[] = [];
  for (const heading of new Set([...before.keys(), ...after.keys()])) {
    const priorBytes = before.get(heading) ?? 0;
    const bytes = after.get(heading) ?? 0;
    const deltaBytes = bytes - priorBytes;
    const status: SectionMove["status"] =
      priorBytes === 0 ? "added" : bytes === 0 ? "removed" : deltaBytes > 0 ? "grew" : deltaBytes < 0 ? "shrank" : "same";
    moves.push({ heading, bytes, priorBytes, deltaBytes, status });
  }
  return moves.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
}
