import { parseCommandEnvelope } from './commands.js';

/**
 * The text a **person** typed, pulled out of a thread's opening prompt.
 *
 * Most of an opening prompt on the wire is not the person's: the harness injects
 * `<system-reminder>` blocks carrying `CLAUDE.md`, `AGENTS.md`, the memory index
 * and the date, and a slash command inlines its whole definition after the
 * arguments. All of it is byte-identical across every run in the repo, so none of
 * it distinguishes one thread from another.
 *
 * The system prompt never appears here: it travels in the request's `system`
 * field, not in `messages`.
 */

/** The harness-injected context blocks, including one a truncated prompt left unclosed. */
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const OPEN_REMINDER_RE = /<system-reminder>[\s\S]*$/i;
/** The CLI's caveat around a locally-run command, and the leftover envelope tags. */
const COMMAND_NOISE_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<\/?command-[a-z-]+>/gi;
const OPEN_CAVEAT_RE = /<local-command-caveat>[\s\S]*$/i;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The searchable text of one opening prompt: the criteria a slash command was
 * given, or the message as typed when no command opened the thread. Empty when
 * nothing of the person's survives the stripping.
 *
 * A command run keeps its `/name` in front; the definition inlined after
 * `</command-args>` is dropped.
 */
export function userPromptText(prompt: string | null | undefined): string {
  if (!prompt) return '';

  const envelope = parseCommandEnvelope(prompt);
  if (envelope) return collapse(`/${envelope.command} ${envelope.prompt}`);

  return collapse(
    prompt
      .replace(REMINDER_RE, '')
      .replace(OPEN_REMINDER_RE, '')
      .replace(OPEN_CAVEAT_RE, '')
      .replace(COMMAND_NOISE_RE, ''),
  );
}

/** Lowercased and whitespace-collapsed — the form both sides of a match are compared in. */
const fold = (s: string): string => collapse(s).toLowerCase();

/**
 * Split a query into the terms that must all appear. Whitespace separates terms,
 * and double quotes group one that contains whitespace.
 */
export function promptQueryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = fold(match[1] ?? match[2] ?? '');
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Whether one prompt answers a query. Every term must appear, case-insensitively
 * and in any order; an empty query matches everything.
 */
export function promptMatches(text: string | null | undefined, query: string): boolean {
  const terms = promptQueryTerms(query);
  if (terms.length === 0) return true;
  if (!text) return false;
  const haystack = fold(text);
  return terms.every((term) => haystack.includes(term));
}

/**
 * A window of the prompt around the first term that matched, capped at `max`
 * characters with `…` marking either cut. Falls back to the head of the prompt
 * when nothing matched.
 */
export function promptExcerpt(text: string | null | undefined, query: string, max = 160): string {
  if (!text) return '';
  const one = collapse(text);
  if (one.length <= max) return one;

  const terms = promptQueryTerms(query);
  const at = terms.length ? one.toLowerCase().indexOf(terms[0]!) : -1;
  if (at < 0) return `${one.slice(0, max - 1).trimEnd()}…`;

  // Centre the match, then pull back inside the string at either end.
  const start = Math.max(0, Math.min(at - Math.floor((max - terms[0]!.length) / 2), one.length - max));
  const slice = one.slice(start, start + max).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + max < one.length ? '…' : ''}`;
}
