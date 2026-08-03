import { describe, expect, it } from 'vitest';
import {
  normalizeSystemPromptText,
  outlineSystemPrompt,
  parseSystemPromptText,
  summarizeSystemPrompt,
  SYSTEM_PROMPT_MAX_BYTES,
  utf8Bytes,
} from '../src/system-prompt.js';

describe('outlineSystemPrompt', () => {
  it('has no sections for an empty document', () => {
    expect(outlineSystemPrompt('')).toEqual([]);
  });

  it('reads headings in document order with their depth and line', () => {
    const outline = outlineSystemPrompt('# Top\n\nbody\n\n## Nested\n\nmore\n');

    expect(outline.map((s) => [s.heading, s.level, s.line])).toEqual([
      ['Top', 1, 1],
      ['Nested', 2, 5],
    ]);
  });

  it('sizes each section up to the next heading, and the last one to EOF', () => {
    const text = '# A\nxx\n## B\nyyy\n';
    const [a, b] = outlineSystemPrompt(text);

    // "# A\nxx\n" is 7 bytes; the rest is B's.
    expect(a?.bytes).toBe(7);
    expect(b?.bytes).toBe(utf8Bytes(text) - 7);
  });

  it('ignores `#` lines inside a fenced block — a shell comment is not a section', () => {
    const outline = outlineSystemPrompt('# Real\n\n```sh\n# not a heading\n```\n\n## Also real\n');

    expect(outline.map((s) => s.heading)).toEqual(['Real', 'Also real']);
  });

  it('measures in UTF-8 bytes, not code units', () => {
    const [only] = outlineSystemPrompt('# é\n');

    expect(only?.bytes).toBe(5); // "#", " ", 2-byte "é", "\n"
  });
});

describe('summarizeSystemPrompt', () => {
  it('reports an absent file as empty rather than failing', () => {
    const doc = summarizeSystemPrompt({ path: '/x/CLAUDE.md', exists: false, text: '', modified: null });

    expect(doc).toMatchObject({ exists: false, bytes: 0, estTokens: 0, lines: 0, sections: [], modified: null });
  });

  it('carries size, a token estimate and the outline', () => {
    const doc = summarizeSystemPrompt({
      path: '/x/CLAUDE.md',
      exists: true,
      text: '# Rules\n\nBe brief.\n',
      modified: '2026-08-02T00:00:00.000Z',
    });

    expect(doc.bytes).toBe(19);
    expect(doc.estTokens).toBe(5);
    expect(doc.lines).toBe(3);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Rules']);
  });

  it('counts the same lines with or without the closing newline', () => {
    const withNewline = summarizeSystemPrompt({ path: '/x', exists: true, text: 'a\nb\n', modified: null });
    const without = summarizeSystemPrompt({ path: '/x', exists: true, text: 'a\nb', modified: null });

    expect(withNewline.lines).toBe(2);
    expect(without.lines).toBe(2);
  });
});

describe('normalizeSystemPromptText', () => {
  it('converts CRLF and closes with exactly one newline', () => {
    expect(normalizeSystemPromptText('a\r\nb\n\n\n')).toBe('a\nb\n');
  });

  it('leaves an emptied prompt empty rather than writing a lone newline', () => {
    expect(normalizeSystemPromptText('   \n\n')).toBe('');
  });
});

describe('parseSystemPromptText', () => {
  it('returns the canonical form of a valid edit', () => {
    expect(parseSystemPromptText('# Rules\r\n')).toBe('# Rules\n');
  });

  it("refuses anything that isn't a string", () => {
    expect(() => parseSystemPromptText(undefined)).toThrow(/must be a string/);
    expect(() => parseSystemPromptText({ text: 'hi' })).toThrow(/must be a string/);
  });

  it('refuses a prompt past the ceiling', () => {
    expect(() => parseSystemPromptText('x'.repeat(SYSTEM_PROMPT_MAX_BYTES + 1))).toThrow(/larger than/);
  });

  it('accepts one that lands exactly on the ceiling once its closing newline is added', () => {
    const text = parseSystemPromptText('x'.repeat(SYSTEM_PROMPT_MAX_BYTES - 1));

    expect(utf8Bytes(text)).toBe(SYSTEM_PROMPT_MAX_BYTES);
  });
});
