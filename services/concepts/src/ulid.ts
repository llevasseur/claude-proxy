/**
 * ULIDs, derived rather than random.
 *
 * Two properties are wanted at once, and an autoincrement gives neither:
 *
 *   - **Sortable by creation.** A ULID's leading 48 bits are the timestamp, so
 *     lexical order is chronological order and paging needs no separate cursor
 *     column.
 *   - **Stable across a restore.** The randomness half is *not* random here: it
 *     is the first 10 bytes of the SHA-256 of the record itself. Re-importing
 *     the backup, or replaying the same `/teach` twice, regenerates the identical
 *     id — so `INSERT OR IGNORE` makes both operations idempotent for free, and
 *     an export/import round trip preserves every id exactly.
 *
 * The cost is that two byte-identical records saved in the same millisecond
 * collapse into one row. That is the correct outcome, not a lost write: same
 * document, same instant, same concept.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeBase32(value: bigint, length: number): string {
  let out = '';
  let remaining = value;
  for (let i = 0; i < length; i += 1) {
    out = ENCODING[Number(remaining % 32n)]! + out;
    remaining /= 32n;
  }
  return out;
}

/** Builds a ULID from an explicit timestamp and 10 bytes of entropy. */
export function ulid(timeMs: number, randomness: Uint8Array): string {
  if (randomness.length < 10) throw new Error('ulid() needs at least 10 bytes of randomness');
  let random = 0n;
  for (let i = 0; i < 10; i += 1) random = (random << 8n) | BigInt(randomness[i]!);
  const time = BigInt(Math.max(0, Math.floor(timeMs)));
  return encodeBase32(time, TIME_CHARS) + encodeBase32(random, RANDOM_CHARS);
}

/** The first 10 bytes of SHA-256(seed) — the derived half of the id above. */
export async function seedBytes(seed: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return new Uint8Array(digest).slice(0, 10);
}
