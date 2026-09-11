import { describe, expect, it } from 'vitest';
import {
  boundedEditDistance,
  foldForSearch,
  fuzzyAnchoredScoreAll,
  fuzzyMatches,
  fuzzyMatchesAll,
  fuzzyScore,
  fuzzyScoreAll,
  fuzzyScoreBest,
  typoBudget,
} from '../src/fuzzy.js';

const TERM = 'Incremental Delivery';

describe('fuzzyScore', () => {
  // The reader who could not find this term is the reason the module exists.
  it.each(['Incremental Delivery', 'in', 'inc', 'incremental', 'delivery', 'Delivery'])(
    'finds "Incremental Delivery" from %j',
    (typed) => {
      expect(fuzzyScore(TERM, typed)).not.toBeNull();
    },
  );

  it.each(['imcremental', 'incrementel', 'increnental', 'delivary', 'dleivery'])('survives the typo %j', (typed) => {
    expect(fuzzyScore(TERM, typed)).not.toBeNull();
  });

  it('finds a misspelt partial', () => {
    expect(fuzzyScore(TERM, 'imcrem')).not.toBeNull();
  });

  it('reads the initials as an acronym', () => {
    expect(fuzzyScore(TERM, 'id')).not.toBeNull();
  });

  it('matches an infix', () => {
    expect(fuzzyScore(TERM, 'cremental')).not.toBeNull();
  });

  it('refuses a two-character infix, which would otherwise match most of the language', () => {
    // `in` must still find "Incremental Delivery" — by the word it starts.
    expect(fuzzyScore(TERM, 'in')).not.toBeNull();
    // …but not "training", where it sits mid-word.
    expect(fuzzyScore('training data', 'in')).toBeNull();
    // Three characters is enough to mean something mid-word again.
    expect(fuzzyScore('training data', 'ain')).not.toBeNull();
  });

  it('ranks an exact hit over a prefix, and a prefix over a typo', () => {
    const exact = fuzzyScore('inc', 'inc')!;
    const prefix = fuzzyScore(TERM, 'inc')!;
    const typo = fuzzyScore(TERM, 'imcremental')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(typo);
  });

  it('ranks a word that starts with the needle over one that merely contains it', () => {
    const starts = fuzzyScore('delivery cadence', 'deliv')!;
    const contains = fuzzyScore('undelivered', 'deliv')!;
    expect(starts).toBeGreaterThan(contains);
  });

  it('refuses text that answers nothing', () => {
    expect(fuzzyScore(TERM, 'kubernetes')).toBeNull();
    expect(fuzzyScore(TERM, 'zzzz')).toBeNull();
  });

  it('gives a short needle no typo budget, so it stays a prefix search', () => {
    // `inx` is one edit from `inc`, but three characters is too short to spend
    // a budget on without matching most of the corpus.
    expect(fuzzyScore(TERM, 'inx')).toBeNull();
    expect(fuzzyScore(TERM, 'inc')).not.toBeNull();
  });

  it('ignores case, accents and surrounding whitespace', () => {
    expect(fuzzyScore('Café Métrique', '  cafe ')).not.toBeNull();
    expect(fuzzyScore('Café Métrique', 'METRIQUE')).not.toBeNull();
  });

  it('answers nothing for an empty needle or an empty text', () => {
    expect(fuzzyScore(TERM, '')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBeNull();
  });

  it('reaches a word in a long body of prose', () => {
    const prose = `${'filler words and more filler '.repeat(40)} incremental delivery ${'tail '.repeat(40)}`;
    expect(fuzzyScore(prose, 'imcremental')).not.toBeNull();
    expect(fuzzyScore(prose, 'kubernetes')).toBeNull();
  });
});

describe('fuzzyMatches', () => {
  it('is the boolean face of fuzzyScore', () => {
    expect(fuzzyMatches(TERM, 'inc')).toBe(true);
    expect(fuzzyMatches(TERM, 'kubernetes')).toBe(false);
  });
});

describe('fuzzyScoreAll', () => {
  it('requires every term', () => {
    expect(fuzzyScoreAll(TERM, ['inc', 'deliv'])).not.toBeNull();
    expect(fuzzyScoreAll(TERM, ['inc', 'kubernetes'])).toBeNull();
  });

  it('scores two answered terms above one', () => {
    const both = fuzzyScoreAll(TERM, ['incremental', 'delivery'])!;
    const one = fuzzyScoreAll(TERM, ['incremental'])!;
    expect(both).toBeGreaterThan(one);
  });

  it('treats no terms at all as an unnarrowed search', () => {
    expect(fuzzyScoreAll(TERM, [])).toBe(0);
    expect(fuzzyMatchesAll(TERM, [])).toBe(true);
  });
});

describe('fuzzyAnchoredScoreAll', () => {
  it('accepts a needle answered at the start of the text, of a word, or by the initials', () => {
    expect(fuzzyAnchoredScoreAll(TERM, ['inc'])).not.toBeNull();
    expect(fuzzyAnchoredScoreAll(TERM, ['delivery'])).not.toBeNull();
    expect(fuzzyAnchoredScoreAll(TERM, ['id'])).not.toBeNull();
  });

  it('refuses a needle answered only mid-word or only by a near-miss', () => {
    // Both still match — they are just not the reader naming the term.
    expect(fuzzyScore(TERM, 'cremental')).not.toBeNull();
    expect(fuzzyAnchoredScoreAll(TERM, ['cremental'])).toBeNull();
    expect(fuzzyScore(TERM, 'imcremental')).not.toBeNull();
    expect(fuzzyAnchoredScoreAll(TERM, ['imcremental'])).toBeNull();
  });

  it('requires every needle, and refuses an empty list rather than leading with everything', () => {
    expect(fuzzyAnchoredScoreAll(TERM, ['inc', 'deliv'])).not.toBeNull();
    expect(fuzzyAnchoredScoreAll(TERM, ['inc', 'cremental'])).toBeNull();
    expect(fuzzyAnchoredScoreAll(TERM, [])).toBeNull();
  });
});

describe('fuzzyScoreBest', () => {
  it('takes the best field rather than the first', () => {
    const best = fuzzyScoreBest(['a note mentioning delivery', 'Delivery'], 'delivery')!;
    expect(best).toBe(fuzzyScore('Delivery', 'delivery'));
  });

  it('is null when no field answers', () => {
    expect(fuzzyScoreBest(['one', 'two'], 'kubernetes')).toBeNull();
  });
});

describe('boundedEditDistance', () => {
  it('counts a transposition as one edit', () => {
    expect(boundedEditDistance('dleivery', 'delivery', 2)).toBe(1);
  });

  it('counts a substitution as one edit', () => {
    expect(boundedEditDistance('imcremental', 'incremental', 2)).toBe(1);
  });

  it('is zero for identical strings, whatever the budget', () => {
    expect(boundedEditDistance('same', 'same', 0)).toBe(0);
  });

  it('abandons a pair further apart than the budget', () => {
    expect(boundedEditDistance('alpha', 'omega', 1)).toBe(2);
    expect(boundedEditDistance('short', 'considerably longer', 2)).toBe(3);
  });
});

describe('typoBudget', () => {
  it('spends nothing on a needle too short to spend it on', () => {
    expect(typoBudget(1)).toBe(0);
    expect(typoBudget(3)).toBe(0);
  });

  it('grows once with length, and only once', () => {
    expect(typoBudget(4)).toBe(1);
    expect(typoBudget(6)).toBe(1);
    expect(typoBudget(7)).toBe(2);
    expect(typoBudget(40)).toBe(2);
  });
});

describe('foldForSearch', () => {
  it('folds case, accents and whitespace into the comparable form', () => {
    expect(foldForSearch('  Éxample   Text ')).toBe('example text');
  });
});
