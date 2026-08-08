/**
 * Compares two secrets without an early exit on the first differing byte.
 *
 * Length is compared up front and therefore leaks, which is accepted: the
 * token's length is not the secret, and padding to hide it would buy nothing
 * against an attacker who can already time requests across the open internet.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

/** True when the request carries the shared bearer token. */
export function isAuthorized(request: Request, token: string | undefined): boolean {
  // An unset secret denies everything rather than defaulting open — a Worker
  // deployed before `wrangler secret put` should serve nothing at all.
  if (!token) return false;
  const header = request.headers.get('authorization');
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(match[1]!, token);
}
