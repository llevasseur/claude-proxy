import { describe, expect, it } from 'vitest';
// The proxy is zero-dependency and mirrors this package's transcript grammar rather
// than importing it; reaching across here pins the two together. Node strips the
// proxy's types to run it, so the specifier keeps its `.ts` extension.
import { countNodeLines, distillMessagesEntries } from '../../../proxy/session.ts';
import { parseSessionNodes, parseSessionNodeTexts } from '../src/sessions.js';

/** One distilled transcript line and the whole text behind it. */
interface Entry {
  line: string;
  full: string | null;
}

const long = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');

describe('parseSessionNodeTexts', () => {
  it('reads a node index → whole text map, sparsely', () => {
    const sidecar = ['{"i":0,"text":"the whole task"}', '{"i":7,"text":"the whole command"}'].join('\n');
    expect(parseSessionNodeTexts(sidecar)).toEqual({ 0: 'the whole task', 7: 'the whole command' });
  });

  it("keeps the text's own line breaks", () => {
    expect(parseSessionNodeTexts(JSON.stringify({ i: 1, text: 'one\ntwo' }))).toEqual({ 1: 'one\ntwo' });
  });

  it('skips torn, malformed, and mistyped lines rather than failing the read', () => {
    const sidecar = [
      '{"i":0,"text":"kept"}',
      '{"i":1,"text":"tor',
      'not json at all',
      '{"i":"2","text":"index not a number"}',
      '{"i":3}',
      '{"i":-1,"text":"negative"}',
      '',
      '{"i":4,"text":"also kept"}',
    ].join('\n');
    expect(parseSessionNodeTexts(sidecar)).toEqual({ 0: 'kept', 4: 'also kept' });
  });

  it("reads an absent sidecar's empty contents as nothing to expand", () => {
    expect(parseSessionNodeTexts('')).toEqual({});
  });
});

describe('node accounting agrees with the proxy', () => {
  /** A turn of each shape the proxy distills, every one long enough to be truncated. */
  const messages = [
    { role: 'user', content: [{ type: 'text', text: long('task', 80) }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: long('reasoning', 60) },
        { type: 'tool_use', name: 'Bash', input: { command: long('echo', 40) } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/short/path.ts' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', is_error: true, content: long('boom', 60) }] },
    { role: 'assistant', content: [{ type: 'text', text: long('outcome', 60) }] },
  ];

  const entries: Entry[] = distillMessagesEntries(messages);
  const transcript = entries.map((e) => e.line).join('\n');

  it('emits exactly one node per distilled line, in the same order', () => {
    const nodes = parseSessionNodes(transcript);
    expect(nodes).toHaveLength(entries.length);
    expect(nodes.map((n) => n.type)).toEqual(['task', 'decision', 'tool', 'tool', 'error', 'done']);
  });

  it("counts the transcript's nodes the way the parser does", () => {
    expect(countNodeLines(transcript)).toBe(parseSessionNodes(transcript).length);
  });

  it('counts nothing for header lines, which are not nodes', () => {
    const header = [
      '',
      '# Session ab3167129339d34f',
      '- model: claude-opus-4-8',
      '- title: Fix it',
      '- subtitle: Fix it',
      '',
    ];
    expect(countNodeLines(header.join('\n'))).toBe(0);
  });

  it('indexes each whole text against the node its line became', () => {
    const nodes = parseSessionNodes(transcript);
    entries.forEach((entry: Entry, i: number) => {
      if (entry.full === null) return;
      const stored = parseSessionNodeTexts(JSON.stringify({ i, text: entry.full }));
      expect(stored[i]).toBe(entry.full);
      // The stored text carries on from where the node's gist broke off.
      const gist = nodes[i]!.text;
      expect(gist).toContain('…');
      expect(entry.full.startsWith(gist.slice(0, gist.indexOf('…')))).toBe(true);
      expect(entry.full.length).toBeGreaterThan(gist.length);
    });
  });

  it('records nothing extra for a line that already says the whole thing', () => {
    const short: Entry[] = distillMessagesEntries([
      { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] },
    ]);
    expect(short).toEqual([{ line: '- done: All tests pass.', full: null }]);
  });
});
