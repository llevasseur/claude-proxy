/**
 * The outline logic exists twice — `packages/core/src/wire-prompt.ts` for the
 * API and the backfill, `proxy/system-prompt.ts` for the proxy, which ships no
 * runtime dependencies and so cannot import this package. This is the test that
 * keeps them honest: a drift in either shows up as a stored outline that
 * disagrees with the one the dashboard recomputes.
 */

import { outlineWirePrompt as coreOutline, sectionsOfText as coreSections } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';
import {
  hashPrompt as proxyHash,
  outlineWirePrompt as proxyOutline,
  sectionsOfText as proxySections,
} from '../../proxy/system-prompt.ts';
import { hashWirePrompt } from '../src/prompt-store.js';

const block = (text: string, ttl?: string) => ({
  type: 'text',
  text,
  ...(ttl ? { cache_control: { type: 'ephemeral', ttl } } : {}),
});

/** Every shape and edge case either implementation has to agree on. */
const CASES: { name: string; system: unknown }[] = [
  { name: 'absent', system: undefined },
  { name: 'null', system: null },
  { name: 'bare string', system: '# Only\nbody text' },
  { name: 'empty array', system: [] },
  { name: 'empty text block', system: [block('')] },
  { name: 'no headings at all', system: [block('just a paragraph\nand another')] },
  { name: 'preamble then headings', system: [block('intro\n# A\naaa\n## B\nbbb\n### C\nccc')] },
  { name: 'heading at every level', system: [block('# 1\na\n## 2\nb\n### 3\nc\n#### 4\nd\n##### 5\ne\n###### 6\nf')] },
  { name: 'seven hashes is not a heading', system: [block('####### nope\nbody')] },
  { name: 'backtick fence hides headings', system: [block('# Real\n```sh\n# hidden\n```\n# Also real')] },
  { name: 'tilde fence hides headings', system: [block('# Real\n~~~\n# hidden\n~~~\n# Also real')] },
  { name: 'mismatched fences stay open', system: [block('# Real\n```\n# hidden\n~~~\n# still hidden')] },
  { name: 'indented fence', system: [block('# Real\n   ```\n# hidden\n   ```\n# Back')] },
  {
    name: 'multi-byte headings and bodies',
    system: [block('# Héllo — wörld\n日本語の本文\n## Ünicode\némoji 🎉 here')],
  },
  { name: 'trailing whitespace on a heading', system: [block('#   Spaced   \nbody')] },
  { name: 'several blocks', system: [block('# A\naaa'), block('# B\nbbb'), block('plain')] },
  { name: 'cache control ttls', system: [block('# A\na', '1h'), block('# B\nb', '5m'), block('# C\nc')] },
  { name: 'repeated heading across blocks', system: [block('# Tools\nabc'), block('# Tools\ndef')] },
  { name: 'no trailing newline', system: [block('# A\nlast line with no newline')] },
  { name: 'blank block among text', system: [block('# A\na'), block(''), block('# C\nc')] },
  { name: 'block with no text field', system: [{ type: 'image', source: {} }] },
  { name: 'crlf line endings', system: [block('# A\r\naaa\r\n# B\r\nbbb')] },
];

describe('wire-prompt outline parity', () => {
  for (const { name, system } of CASES) {
    it(`agrees on ${name}`, () => {
      expect(proxyOutline(system)).toEqual(coreOutline(system));
    });
  }

  it('hashes identically, so a backfilled sidecar lands in the live cohort', () => {
    for (const { system } of CASES) expect(hashWirePrompt(system)).toBe(proxyHash(system));
  });

  it('agrees on the raw section splitter', () => {
    const text = 'lead\n# A\nbody é\n```\n# hidden\n```\n## B\ntail';
    expect(proxySections(text, 3)).toEqual(coreSections(text, 3));
  });

  it("reports byte counts that match the proxy's own systemBytes measure", () => {
    for (const { system } of CASES) {
      const expected = system === undefined || system === null ? 0 : Buffer.byteLength(JSON.stringify(system));
      expect(coreOutline(system).bytes).toBe(expected);
    }
  });
});
