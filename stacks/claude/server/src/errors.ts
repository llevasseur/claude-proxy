/**
 * Reading a thrown value. A `catch` binding is the one place TypeScript hands
 * back `unknown` with no boundary to decode at, so these two functions are that
 * boundary: everything downstream takes an `Error` or a message string.
 *
 * The parameter is named `cause` throughout, which is what it is — the value the
 * failing call threw, on its way into an `Error`'s `cause` or a log line.
 */

/** The thrown value as an `Error`, wrapping whatever non-`Error` was thrown. */
export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** The message of a thrown value, whatever was actually thrown. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
