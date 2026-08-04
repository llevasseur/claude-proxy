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
export const PREAMBLE = '(preamble)';

/**
 * Split one block's text into heading spans. Lines inside a fenced code block
 * are skipped, so a shell comment is not a section. Mirrored in
 * `proxy/system-prompt.ts`; the two are held together by
 * `server/test/wire-prompt-parity.test.ts`.
 */
export function sectionsOfText(text: string, block: number): WirePromptSection[] {
  return spansOfText(text, block).spans.map((s) => ({
    block: s.block,
    heading: s.heading,
    level: s.level,
    bytes: s.bytes,
  }));
}

/** A span plus the line range it covers, which the stored outline drops. */
interface WirePromptSpan extends WirePromptSection {
  /** First line of the span, and one past its last. */
  from: number;
  to: number;
}

/**
 * The shared parse behind {@link sectionsOfText} and
 * {@link wirePromptSectionTexts}. Byte counts come from offset arithmetic and
 * the range from line indices, so a multi-byte character cannot desync them.
 * Returns ranges rather than text — every outline parse comes through here, and
 * only the section reader needs the strings.
 */
function spansOfText(text: string, block: number): { lines: string[]; spans: WirePromptSpan[] } {
  const lines = text.split('\n');
  const found: { heading: string; level: number; offset: number; line: number }[] = [];
  let fence: string | null = null;
  let offset = 0;

  lines.forEach((line, index) => {
    const opener = FENCE_RE.exec(line);
    if (fence) {
      if (opener && opener[1] === fence) fence = null;
    } else if (opener) {
      fence = opener[1]!;
    } else {
      const heading = HEADING_RE.exec(line);
      if (heading) found.push({ heading: heading[2]!, level: heading[1]!.length, offset, line: index });
    }
    offset += textBytes(line) + 1; // the newline this split consumed
  });

  const total = textBytes(text);
  const spans: WirePromptSpan[] = [];
  // Text before the first heading is still bytes on the wire, so it gets a row.
  const firstOffset = found[0]?.offset ?? total;
  const firstLine = found[0]?.line ?? lines.length;
  if (firstOffset > 0) {
    spans.push({ block, heading: PREAMBLE, level: 0, bytes: firstOffset, from: 0, to: firstLine });
  }
  found.forEach((h, i) => {
    const next = found[i + 1];
    spans.push({
      block,
      heading: h.heading,
      level: h.level,
      bytes: (next?.offset ?? total) - h.offset,
      from: h.line,
      to: next?.line ?? lines.length,
    });
  });
  return { lines, spans };
}

/** Text of one `system` entry, for the shapes the API accepts. */
function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (typeof block === 'object' && block !== null) {
    const t = (block as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}

function blockCacheTtl(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null;
  const cc = (block as { cache_control?: unknown }).cache_control;
  if (typeof cc !== 'object' || cc === null) return null;
  const ttl = (cc as { ttl?: unknown }).ttl;
  return typeof ttl === 'string' ? ttl : 'ephemeral';
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
    if (text !== '') sections.push(...sectionsOfText(text, index));
  });

  return { bytes: jsonBytes(system), blocks, sections };
}

/**
 * The text behind each entry of {@link outlineWirePrompt}'s `sections`, in the
 * same order and with the same skip rule, so index `i` here is section `i`
 * there. A stored outline keeps byte counts only, so reading a section back
 * needs the request body it was derived from.
 */
export function wirePromptSectionTexts(system: unknown): string[] {
  if (system === undefined || system === null) return [];

  const texts: string[] = [];
  for (const [index, block] of (Array.isArray(system) ? system : [system]).entries()) {
    const text = blockText(block);
    if (text === '') continue;
    const { lines, spans } = spansOfText(text, index);
    for (const s of spans) texts.push(lines.slice(s.from, s.to).join('\n'));
  }
  return texts;
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
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.hash === 'string' && typeof v.bytes === 'number' && Array.isArray(v.blocks) && Array.isArray(v.sections)
  );
}

/**
 * Headings carried only by Claude Code's auto-mode permission classifier — the
 * separate ~110 KB prompt sent once per agent tool call, which never appears in
 * a prompt the user wrote.
 *
 * Both must be present. Matching on headings rather than size is deliberate: a
 * byte threshold silently reclassifies every prompt that drifts across it, and
 * the classifier's own size moves between revisions.
 */
const CLASSIFIER_HEADINGS = ['HARD BLOCK', 'SOFT BLOCK'] as const;

/**
 * Whether an outline is a permission-classifier prompt rather than a request the
 * user asked for. Needs only `sections`, so it runs against a stored outline —
 * the store keeps headings long after the request bodies age out.
 */
export function isClassifierPrompt(outline: Pick<WirePromptOutline, 'sections'>): boolean {
  return CLASSIFIER_HEADINGS.every((prefix) => outline.sections.some((s) => s.heading.startsWith(prefix)));
}

/** One heading's slice of a prompt. */
export interface SectionShare {
  heading: string;
  /** Shallowest depth the heading was seen at; 0 for a preamble. */
  level: number;
  /** Blocks the heading appears in, ascending. */
  blocks: number[];
  /** Raw text bytes, summed across every block carrying this heading. */
  bytes: number;
  /** Fraction 0–1 of the prompt's section bytes. */
  share: number;
}

/**
 * What a prompt is made of, biggest section first.
 *
 * Share is of the sections' own total rather than the outline's `bytes`, so it
 * sums to 1: block bytes also carry JSON escaping and the text-block envelope,
 * which no section owns.
 */
export function sectionShares(outline: Pick<WirePromptOutline, 'sections'>): SectionShare[] {
  const rows = new Map<string, SectionShare>();
  let total = 0;
  for (const s of outline.sections) {
    total += s.bytes;
    const row = rows.get(s.heading);
    if (!row) {
      rows.set(s.heading, { heading: s.heading, level: s.level, blocks: [s.block], bytes: s.bytes, share: 0 });
      continue;
    }
    row.bytes += s.bytes;
    row.level = Math.min(row.level, s.level);
    if (!row.blocks.includes(s.block)) row.blocks.push(s.block);
  }

  const out = [...rows.values()];
  for (const row of out) {
    row.blocks.sort((a, b) => a - b);
    row.share = total > 0 ? row.bytes / total : 0;
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** One section's movement between two versions of a prompt. */
export interface SectionMove {
  heading: string;
  /** Bytes now; 0 when the section was dropped. */
  bytes: number;
  /** Bytes before; 0 when the section is new. */
  priorBytes: number;
  deltaBytes: number;
  status: 'added' | 'removed' | 'grew' | 'shrank' | 'same';
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
  prior: Pick<WirePromptOutline, 'sections'>,
  current: Pick<WirePromptOutline, 'sections'>,
): SectionMove[] {
  const before = byHeading(prior.sections);
  const after = byHeading(current.sections);

  const moves: SectionMove[] = [];
  for (const heading of new Set([...before.keys(), ...after.keys()])) {
    const priorBytes = before.get(heading) ?? 0;
    const bytes = after.get(heading) ?? 0;
    const deltaBytes = bytes - priorBytes;
    const status: SectionMove['status'] =
      priorBytes === 0
        ? 'added'
        : bytes === 0
          ? 'removed'
          : deltaBytes > 0
            ? 'grew'
            : deltaBytes < 0
              ? 'shrank'
              : 'same';
    moves.push({ heading, bytes, priorBytes, deltaBytes, status });
  }
  return moves.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
}
