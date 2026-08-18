import { describe, expect, it } from 'vitest';
import {
  diffWirePrompts,
  outlineWirePrompt,
  PREAMBLE,
  sectionShares,
  sectionsOfText,
  wirePromptSectionTexts,
} from '../src/wire-prompt.js';

/** A wire system block as the CLI sends it; `cache_control` is absent on an uncached one. */
interface WireBlock {
  type: string;
  text: string;
  cache_control?: { type: string; ttl: string };
}

const block = (text: string, ttl?: string): WireBlock => {
  // The key must stay absent rather than be set to `undefined`: several assertions
  // below count `JSON.stringify` bytes, which a present key would change.
  const b: WireBlock = { type: 'text', text };
  if (ttl) b.cache_control = { type: 'ephemeral', ttl };
  return b;
};

describe('outlineWirePrompt', () => {
  it('reports zero for an absent system field', () => {
    expect(outlineWirePrompt(undefined)).toEqual({ bytes: 0, blocks: [], sections: [] });
    expect(outlineWirePrompt(null)).toEqual({ bytes: 0, blocks: [], sections: [] });
  });

  it('counts the same bytes the proxy records as systemBytes', () => {
    const system = [block('# One\nhello'), block('# Two\nworld')];
    expect(outlineWirePrompt(system).bytes).toBe(Buffer.byteLength(JSON.stringify(system)));
  });

  it('treats a bare string as a single block', () => {
    const outline = outlineWirePrompt('# Only\nbody');
    expect(outline.blocks).toHaveLength(1);
    expect(outline.sections.map((s) => s.heading)).toEqual(['Only']);
  });

  it('splits each block into heading spans that sum to its text bytes', () => {
    const outline = outlineWirePrompt([block('intro\n# A\naaa\n## B\nbbb')]);
    expect(outline.sections.map((s) => [s.heading, s.level])).toEqual([
      [PREAMBLE, 0],
      ['A', 1],
      ['B', 2],
    ]);
    const summed = outline.sections.reduce((a, s) => a + s.bytes, 0);
    expect(summed).toBe(outline.blocks[0]!.textBytes);
  });

  it('ignores headings inside fenced code', () => {
    const outline = outlineWirePrompt([block('# Real\n```sh\n# not a heading\n```\n# Also real')]);
    expect(outline.sections.map((s) => s.heading)).toEqual(['Real', 'Also real']);
  });

  it('records cache ttl per block', () => {
    const outline = outlineWirePrompt([block('a', '1h'), block('b')]);
    expect(outline.blocks.map((b) => b.cacheTtl)).toEqual(['1h', null]);
  });

  it('counts multi-byte characters as their utf-8 length', () => {
    const [section] = sectionsOfText('# Héllo — ok', 0);
    expect(section!.bytes).toBe(Buffer.byteLength('# Héllo — ok'));
  });
});

describe('sectionShares', () => {
  it('ranks sections largest first, and the shares sum to one', () => {
    const outline = outlineWirePrompt([block(`# Small\ntiny\n# Big\n${'x'.repeat(500)}`)]);
    const shares = sectionShares(outline);
    expect(shares.map((s) => s.heading)).toEqual(['Big', 'Small']);
    expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10);
    expect(shares[0]!.share).toBeGreaterThan(0.9);
  });

  it('sums a heading repeated across blocks into one row, recording both blocks', () => {
    const outline = outlineWirePrompt([block('# Tools\nabc'), block('# Tools\ndefgh')]);
    const [tools] = sectionShares(outline);
    expect(tools).toMatchObject({ heading: 'Tools', blocks: [0, 1], level: 1 });
    expect(tools!.bytes).toBe(outline.sections.reduce((a, s) => a + s.bytes, 0));
  });

  it('keeps the shallowest depth when a heading appears at two levels', () => {
    const outline = outlineWirePrompt([block('## Rules\na'), block('# Rules\nb')]);
    expect(sectionShares(outline)[0]!.level).toBe(1);
  });

  it('returns nothing rather than dividing by zero for an empty prompt', () => {
    expect(sectionShares({ sections: [] })).toEqual([]);
  });
});

describe('wirePromptSectionTexts', () => {
  it('returns one text per outline section, in the same order', () => {
    const system = [block('intro\n# A\naaa\n## B\nbbb'), block('# C\nccc')];
    const texts = wirePromptSectionTexts(system);
    expect(texts).toHaveLength(outlineWirePrompt(system).sections.length);
    expect(texts).toEqual(['intro', '# A\naaa', '## B\nbbb', '# C\nccc']);
  });

  it('gives back exactly the bytes the outline counted', () => {
    const system = [block('intro\n# Héllo — ok\nbody\n# Next\nmore')];
    const outline = outlineWirePrompt(system);
    wirePromptSectionTexts(system).forEach((text, i) => {
      // Every span but the last carries the newline that ends it.
      const trailing = i === outline.sections.length - 1 ? 0 : 1;
      expect(Buffer.byteLength(text) + trailing).toBe(outline.sections[i]!.bytes);
    });
  });

  it('skips empty blocks the same way the outline does', () => {
    const system = [block(''), block('# Only\nbody')];
    expect(wirePromptSectionTexts(system)).toEqual(['# Only\nbody']);
  });

  it('keeps fenced headings inside their section rather than splitting on them', () => {
    const [only] = wirePromptSectionTexts([block('# Real\n```sh\n# not a heading\n```')]);
    expect(only).toBe('# Real\n```sh\n# not a heading\n```');
  });

  it('returns nothing for an absent system field', () => {
    expect(wirePromptSectionTexts(undefined)).toEqual([]);
    expect(wirePromptSectionTexts(null)).toEqual([]);
  });
});

describe('diffWirePrompts', () => {
  it('labels added, removed, and resized sections, biggest move first', () => {
    const prior = outlineWirePrompt([block('# Keep\nsame\n# Shrink\nlots and lots of text here\n# Gone\nbye')]);
    const current = outlineWirePrompt([block('# Keep\nsame\n# Shrink\ntiny\n# New\nhello')]);

    const moves = diffWirePrompts(prior, current);
    const byHeading = Object.fromEntries(moves.map((m) => [m.heading, m.status]));
    expect(byHeading).toMatchObject({ Keep: 'same', Shrink: 'shrank', Gone: 'removed', New: 'added' });
    expect(Math.abs(moves[0]!.deltaBytes)).toBeGreaterThanOrEqual(Math.abs(moves[1]!.deltaBytes));
  });

  it('sums a heading repeated across blocks into one row', () => {
    const outline = outlineWirePrompt([block('# Tools\nabc'), block('# Tools\ndef')]);
    const moves = diffWirePrompts({ sections: [] }, outline);
    expect(moves.filter((m) => m.heading === 'Tools')).toHaveLength(1);
  });
});
