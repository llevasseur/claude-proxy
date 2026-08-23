import { describe, expect, it } from 'vitest';
import {
  diffSystemPromptText,
  normalizeSystemPromptText,
  outlineSystemPrompt,
  parseSystemPromptExpectedModified,
  parseSystemPromptText,
  SYSTEM_PROMPT_MAX_BYTES,
  summarizeSystemPrompt,
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
    // 19 bytes at the estimator's measured 2.78 bytes per token (`context.ts`).
    expect(doc.estTokens).toBe(7);
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

describe('parseSystemPromptExpectedModified', () => {
  it('passes an mtime through, and null for "there was no file"', () => {
    expect(parseSystemPromptExpectedModified('2026-08-09T10:00:00.000Z')).toBe('2026-08-09T10:00:00.000Z');
    expect(parseSystemPromptExpectedModified(null)).toBeNull();
  });

  it('reads an absent field as "write regardless" rather than as null', () => {
    expect(parseSystemPromptExpectedModified(undefined)).toBeUndefined();
  });

  it('refuses anything else', () => {
    expect(() => parseSystemPromptExpectedModified(42)).toThrow(/must be a string or null/);
  });
});

describe('diffSystemPromptText', () => {
  it('reports identical text as nothing to write', () => {
    const diff = diffSystemPromptText('# Rules\n', '# Rules\n');

    expect(diff).toMatchObject({ identical: true, added: 0, removed: 0, lines: [] });
  });

  it('shows a changed line as a removal beside its replacement', () => {
    const diff = diffSystemPromptText('# Rules\n\nBe brief.\n', '# Rules\n\nBe terse.\n');

    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['-Be brief.']);
    expect(diff.lines.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['+Be terse.']);
  });

  it('opens each changed region with a hunk header naming both line numbers', () => {
    const diff = diffSystemPromptText('a\nb\nc\n', 'a\nB\nc\n');

    expect(diff.lines[0]).toEqual({ kind: 'gap', text: '@@ -1,3 +1,3 @@' });
  });

  it('keeps only a few lines of context around a change in a long file', () => {
    const before = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const after = before.replace('line 100', 'line one hundred');

    const diff = diffSystemPromptText(before, after);

    // Three lines of context either side of the one change, plus the hunk header.
    expect(diff.lines).toHaveLength(1 + 3 + 2 + 3);
    expect(diff.lines.filter((l) => l.kind === 'context').map((l) => l.text)).toEqual([
      ' line 97',
      ' line 98',
      ' line 99',
      ' line 101',
      ' line 102',
      ' line 103',
    ]);
  });

  it('gathers two nearby changes into one hunk and distant ones into two', () => {
    const before = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const near = before.replace('line 10', 'X').replace('line 12', 'Y');
    const far = before.replace('line 10', 'X').replace('line 50', 'Y');

    expect(diffSystemPromptText(before, near).lines.filter((l) => l.kind === 'gap')).toHaveLength(1);
    expect(diffSystemPromptText(before, far).lines.filter((l) => l.kind === 'gap')).toHaveLength(2);
  });

  it('reads a first save as pure additions against an empty file', () => {
    const diff = diffSystemPromptText('', '# Rules\n\nBe brief.\n');

    expect(diff.removed).toBe(0);
    expect(diff.added).toBe(3);
    expect(diff.lines.every((l) => l.kind === 'gap' || l.kind === 'added')).toBe(true);
  });

  it('reads emptying the prompt as pure removals', () => {
    const diff = diffSystemPromptText('# Rules\nBe brief.\n', '');

    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(2);
  });

  it('shows no lines when only the trailing newline differs, and does not claim they match', () => {
    const diff = diffSystemPromptText('# Rules', '# Rules\n');

    expect(diff.identical).toBe(false);
    expect(diff.lines).toEqual([]);
  });

  it('degrades a wholesale rewrite to a replacement rather than aligning it', () => {
    const before = `${Array.from({ length: 2100 }, (_, i) => `old ${i}`).join('\n')}\n`;
    const after = `${Array.from({ length: 2100 }, (_, i) => `new ${i}`).join('\n')}\n`;

    const diff = diffSystemPromptText(before, after);

    expect(diff.wholeFile).toBe(true);
    expect(diff.removed).toBe(2100);
    expect(diff.added).toBe(2100);
  });
});
