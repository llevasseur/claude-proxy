// What a person actually typed, dug out of the opening prompt the wire carried —
// and whether a plain-text query finds it.
import { describe, expect, it } from 'vitest';
import { promptExcerpt, promptMatches, promptQueryTerms, userPromptText } from '../src/prompt-text.js';

/** The envelope the CLI wraps a slash command in, with its definition inlined after. */
const envelope = (command: string, args: string, definition = 'Boilerplate identical on every run.') =>
  `<command-message>${command}</command-message> <command-name>/${command}</command-name>` +
  `<command-args>${args}</command-args> ${definition}`;

describe('userPromptText', () => {
  it('keeps only the arguments of a slash command, not its definition', () => {
    const text = userPromptText(envelope('task', 'Add full-text search to the Context Size page'));
    expect(text).toBe('/task Add full-text search to the Context Size page');
    expect(text).not.toContain('Boilerplate');
  });

  it('drops the harness-injected context blocks', () => {
    const prompt =
      '<system-reminder>Contents of AGENTS.md: never commit on main. Contents of CLAUDE.md: ...</system-reminder>' +
      'Fix the scroll jump on the artifact panel';
    expect(userPromptText(prompt)).toBe('Fix the scroll jump on the artifact panel');
  });

  it('drops a reminder a truncated prompt left unclosed', () => {
    expect(userPromptText('Reproduce the bug first <system-reminder>Today is 2026-08-08. Contents of')).toBe(
      'Reproduce the bug first',
    );
  });

  it('returns an ordinary message as typed, on one line', () => {
    expect(userPromptText('  Why is\n  context so large?  ')).toBe('Why is context so large?');
  });

  it('reads past a locally-run command to the one that was typed', () => {
    // The caveat sits immediately ahead of the envelope it marks local — that
    // adjacency is what tells `/clear` apart from the command typed after it.
    const prompt =
      '<local-command-caveat>caveat</local-command-caveat><command-name>/clear</command-name>' +
      envelope('pr', '--draft ship it');
    expect(userPromptText(prompt)).toBe('/pr --draft ship it');
  });

  it('is empty for nothing, and for a prompt that was all injected context', () => {
    expect(userPromptText(null)).toBe('');
    expect(userPromptText('')).toBe('');
    expect(userPromptText('<system-reminder>only context</system-reminder>')).toBe('');
  });
});

describe('promptQueryTerms', () => {
  it('splits on whitespace and keeps a quoted phrase whole', () => {
    expect(promptQueryTerms('context  "full text" SEARCH')).toEqual(['context', 'full text', 'search']);
  });

  it('has no terms for an empty or whitespace-only query', () => {
    expect(promptQueryTerms('   ')).toEqual([]);
  });
});

describe('promptMatches', () => {
  const prompt = '/task Add full-text search to the Context Size page';

  it('matches case-insensitively on a substring', () => {
    expect(promptMatches(prompt, 'CONTEXT size')).toBe(true);
  });

  it('requires every term, in any order', () => {
    expect(promptMatches(prompt, 'search context')).toBe(true);
    expect(promptMatches(prompt, 'search trends')).toBe(false);
  });

  it('matches everything on an empty query, including a prompt there is none of', () => {
    expect(promptMatches(prompt, '')).toBe(true);
    expect(promptMatches(null, '  ')).toBe(true);
  });

  it('never matches a request with no recorded prompt', () => {
    expect(promptMatches(null, 'search')).toBe(false);
    expect(promptMatches('', 'search')).toBe(false);
  });
});

describe('promptExcerpt', () => {
  const long = `Preamble that runs on. ${'filler '.repeat(40)}the needle sits here. ${'more '.repeat(40)}`;

  it('returns a short prompt whole', () => {
    expect(promptExcerpt('/pr ship it', 'ship')).toBe('/pr ship it');
  });

  it('shows the window around the match, not the opening words', () => {
    const excerpt = promptExcerpt(long, 'needle');
    expect(excerpt).toContain('needle');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(162);
  });

  it('falls back to the head when nothing matched', () => {
    expect(promptExcerpt(long, '').startsWith('Preamble that runs on.')).toBe(true);
    expect(promptExcerpt(long, 'absent').startsWith('Preamble that runs on.')).toBe(true);
  });

  it('is empty for no prompt', () => {
    expect(promptExcerpt(null, 'x')).toBe('');
  });
});
