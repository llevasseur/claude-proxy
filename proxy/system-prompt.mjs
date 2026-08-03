/**
 * Identity and structure of the request's `system` field.
 *
 * The sidecar records only a hash and two counts; the outline itself is written
 * once per distinct hash under `logs/system-prompts/`, which is not
 * date-prefixed and so survives retention.
 *
 * Mirrors `packages/core/src/wire-prompt.ts` — the duplication is the price of
 * `proxy/` staying zero-dependency plain `.mjs`, and
 * `proxy/system-prompt.test.mjs` holds the two to identical output.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export const PREAMBLE = "(preamble)";

const textBytes = (text) => Buffer.byteLength(text, "utf8");
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Heading spans of one block's text; fenced code is skipped. */
export function sectionsOfText(text, block) {
  const found = [];
  let fence = null;
  let offset = 0;

  for (const line of text.split("\n")) {
    const opener = FENCE_RE.exec(line);
    if (fence) {
      if (opener && opener[1] === fence) fence = null;
    } else if (opener) {
      fence = opener[1];
    } else {
      const heading = HEADING_RE.exec(line);
      if (heading) found.push({ heading: heading[2], level: heading[1].length, offset });
    }
    offset += textBytes(line) + 1;
  }

  const total = textBytes(text);
  const out = [];
  const firstOffset = found.length > 0 ? found[0].offset : total;
  if (firstOffset > 0) out.push({ block, heading: PREAMBLE, level: 0, bytes: firstOffset });
  found.forEach((h, i) => {
    out.push({ block, heading: h.heading, level: h.level, bytes: (i + 1 < found.length ? found[i + 1].offset : total) - h.offset });
  });
  return out;
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (typeof block === "object" && block !== null && typeof block.text === "string") return block.text;
  return "";
}

function blockCacheTtl(block) {
  if (typeof block !== "object" || block === null) return null;
  const cc = block.cache_control;
  if (typeof cc !== "object" || cc === null) return null;
  return typeof cc.ttl === "string" ? cc.ttl : "ephemeral";
}

/** Blocks and heading spans of a captured `system` field. */
export function outlineWirePrompt(system) {
  if (system === undefined || system === null) return { bytes: 0, blocks: [], sections: [] };

  const raw = Array.isArray(system) ? system : [system];
  const blocks = [];
  const sections = [];

  raw.forEach((block, index) => {
    const text = blockText(block);
    blocks.push({ index, bytes: jsonBytes(block), textBytes: textBytes(text), cacheTtl: blockCacheTtl(block) });
    if (text !== "") sections.push(...sectionsOfText(text, index));
  });

  return { bytes: jsonBytes(system), blocks, sections };
}

/** Content hash of a `system` field — the prompt's identity across requests. */
export function hashPrompt(system) {
  return crypto.createHash("sha256").update(JSON.stringify(system ?? null)).digest("hex").slice(0, 16);
}

/** Sidecar-sized identity plus the outline the store keeps. */
export function identifyPrompt(system) {
  if (system === undefined || system === null) return null;
  const outline = outlineWirePrompt(system);
  return {
    hash: hashPrompt(system),
    blocks: outline.blocks.length,
    sections: outline.sections.length,
    outline,
  };
}

export const PROMPT_STORE_DIR = "system-prompts";

/** Hashes written this process, so a repeat costs no syscall. */
const seen = new Set();

/**
 * Write `<logDir>/system-prompts/<hash>.json` unless that hash is already
 * stored. Returns whether a file was written. Never throws — a failed outline
 * write must not cost the request its sidecar.
 */
export function recordPrompt(logDir, identity) {
  if (!identity || seen.has(identity.hash)) return false;
  const dir = path.join(logDir, PROMPT_STORE_DIR);
  const file = path.join(dir, `${identity.hash}.json`);
  try {
    if (fs.existsSync(file)) {
      seen.add(identity.hash);
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          hash: identity.hash,
          firstSeen: new Date().toISOString(),
          bytes: identity.outline.bytes,
          blocks: identity.outline.blocks,
          sections: identity.outline.sections,
        },
        null,
        2,
      ),
    );
    seen.add(identity.hash);
    return true;
  } catch (err) {
    console.error(`[agent-proxy] could not store system prompt outline: ${err.message}`);
    return false;
  }
}
