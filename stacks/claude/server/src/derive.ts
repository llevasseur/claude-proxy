/**
 * Body derivatives — the small values a view renders out of a captured
 * `.request.txt`, as pure functions over the parsed body.
 *
 * They live here because there are two readers. `readSidecars` and `readDir` each
 * carried their own copy of {@link latestUserText}, and two copies of a function
 * whose answers have to agree byte for byte is a parity break waiting to happen.
 *
 * Being separate is also what lets a derivative be computed once, at ingest time,
 * into a column beside the row that points at the body — see `deriveBodies` in
 * `server/src/db/ingest.ts` and `skim_text` in `server/src/db/open.ts`.
 *
 * A captured body is `JSON.parse` output and nothing else, so it is read here as
 * a {@link JsonInput} through the shared readers: every step down the document
 * answers `undefined` for a shape the wire did not have, which is exactly the
 * "no user turn in it" the function already reported as `null`.
 */

import { arrayField, type JsonInput, jsonArray, jsonField, jsonString, stringField } from './json.js';

/** What one captured body yields. Bounded strings only — never the body itself. */
export interface BodyDerivatives {
  /**
   * The last user turn on the wire, trimmed, or `null` when the body carries
   * none. `/api/skim` renders it as the request's shape.
   */
  skimText: string | null;
}

/**
 * The text of the newest `user` message in a captured request body.
 *
 * Walks backwards, takes a string `content` whole and otherwise joins the text
 * blocks of a structured one. `null` when nothing on the wire was a user turn
 * with text in it — which is a real reading of the body, distinct from the body
 * not being there at all.
 */
export function latestUserText(request: JsonInput): string | null {
  const messages = arrayField(request, 'messages');
  if (messages === undefined) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (stringField(message, 'role') !== 'user') continue;
    const content = jsonField(message, 'content');
    const whole = jsonString(content)?.trim();
    if (whole) return whole;
    const blocks = jsonArray(content);
    if (blocks === undefined) continue;
    const parts: string[] = [];
    for (const block of blocks) {
      if (stringField(block, 'type') !== 'text') continue;
      const blockText = stringField(block, 'text')?.trim();
      if (blockText) parts.push(blockText);
    }
    const text = parts.join('\n\n');
    if (text) return text;
  }
  return null;
}

/**
 * Every derivative one body yields, in one pass. Ingest calls this; the readers
 * call {@link latestUserText} directly on the query-time path they still have
 * for a row that predates the extraction.
 */
export function deriveFromBody(request: JsonInput): BodyDerivatives {
  return { skimText: latestUserText(request) };
}
