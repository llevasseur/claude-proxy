/**
 * Body derivatives — the small values a view renders out of a captured
 * `.request.txt`, as pure functions over the parsed body.
 *
 * They live here rather than beside either reader because there are two readers.
 * `readSidecars` opened the body during a directory scan and `readDir` opened it
 * again during a SQL read, and each carried its own copy of
 * {@link latestUserText}; two copies of a function whose answers have to agree
 * byte for byte is a parity break waiting to happen.
 *
 * The other reason they are separate: a derivative computed *here* can be
 * computed once, at ingest time, into a column beside the row that points at the
 * body — which is what lets an evicted day still answer the question. See
 * `deriveBodies` in `server/src/db/ingest.ts` and the `skim_text` column in
 * `server/src/db/open.ts`.
 */

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
export function latestUserText(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) return text;
  }
  return null;
}

/**
 * Every derivative one body yields, in one pass. Ingest calls this; the readers
 * call {@link latestUserText} directly on the query-time path they still have
 * for a row that predates the extraction.
 */
export function deriveFromBody(request: unknown): BodyDerivatives {
  return { skimText: latestUserText(request) };
}
