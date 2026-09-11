/**
 * One fuzzy matcher, behind every search box the dashboard draws.
 *
 * The boxes used to ask `haystack.includes(needle)`, which answers a question
 * nobody is asking: a reader who half-remembers a term types a fragment of it,
 * or types it wrong, and a substring scan says the corpus holds nothing. Typing
 * `imcremental` found no "Incremental Delivery", and neither did `inc`, because
 * the store's bm25 index matches whole tokens and the local scan matched whole
 * substrings.
 *
 * So a match here is **tiered rather than boolean**, and the tier is the score:
 * an exact hit outranks a prefix, a prefix outranks an infix, and a typo ranks
 * last but still ranks. That ordering is what lets a caller sort by relevance
 * without knowing which tier answered, and it is why the bands below are spaced
 * far enough apart that a within-band penalty can never cross into the band
 * beneath it.
 *
 * **Typo tolerance is bounded by the needle's own length**, because the shorter
 * the needle the more of the corpus sits one edit away from it: at two
 * characters every edit-distance-1 match is noise, so short needles get no
 * budget at all and are served by the prefix tiers instead. That is the whole
 * reason `in` finds "Incremental Delivery" without also finding everything else.
 *
 * Deterministic and dependency-free, per this package's contract — no clock, no
 * environment, no I/O. The Worker in `services/concepts` imports it too, which
 * is why it lives here rather than in the admin bundle.
 */

/** Score bands, one per tier. Spaced so a within-band penalty cannot cross down. */
const EXACT = 1000;
const TEXT_PREFIX = 900;
const WORD_PREFIX = 800;
const ACRONYM = 700;
const SUBSTRING = 600;
const WORD_TYPO = 400;
const PREFIX_TYPO = 300;

/** The most a position can cost inside its band, so bands never overlap. */
const MAX_PENALTY = 50;

/** The shortest needle allowed to match mid-word rather than at a word's start. */
const MIN_INFIX = 3;

/** Combining marks, stripped after NFD so `é` and `e` are the same character. */
const COMBINING = /[̀-ͯ]/g;

/** Anything that is neither a letter nor a digit separates one word from the next. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

/**
 * The form both sides of a comparison are held in: decomposed, stripped of
 * accents, lowercased, and with runs of whitespace collapsed to one space.
 */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * How many edits a needle of this length tolerates.
 *
 * Nothing under four characters, because at that length the corpus is dense
 * with words one edit away and a budget would match most of them. Four to six
 * get one edit, which covers a single slip. Seven and up get two, which covers
 * a slip plus a transposition in a word long enough that two edits still leave
 * it recognisable.
 */
export function typoBudget(length: number): number {
  if (length < 4) return 0;
  if (length < 7) return 1;
  return 2;
}

/**
 * Damerau-Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * Transpositions count as one edit rather than two, because a transposed pair
 * is the commonest typing slip there is and charging it double would put
 * `dleivery` out of reach of a budget that `delivary` sits inside.
 *
 * Returns `max + 1` for any pair further apart than `max` — the caller only
 * ever compares against the budget, so the exact distance beyond it is not
 * worth the rows it would take to compute.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (max <= 0) return max + 1;

  // Three rows are enough for Damerau: the transposition step reaches back two.
  let twoBack: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let best = current[0]!;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      let cost = Math.min(substitution, deletion, insertion);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cost = Math.min(cost, twoBack[j - 2]! + 1);
      }
      current[j] = cost;
      if (cost < best) best = cost;
    }
    // Every remaining row can only add to the best cell in this one, so a row
    // whose cheapest cell already exceeds the budget can never come back under.
    if (best > max) return max + 1;
    twoBack = previous;
    previous = current;
    current = new Array(b.length + 1);
  }
  const distance = previous[b.length]!;
  return distance > max ? max + 1 : distance;
}

/** A penalty that grows with position but is capped inside its band. */
const positionPenalty = (at: number): number => Math.min(at, MAX_PENALTY);

/**
 * How well `text` answers `needle`, or `null` when it does not answer it at all.
 * Higher is better, and scores are only ever comparable against each other.
 *
 * The tiers, in the order they are tried:
 *
 * 1. the whole text is the needle;
 * 2. the text starts with it — `inc` for "Incremental Delivery";
 * 3. some word starts with it — `delivery`, mid-phrase;
 * 4. the needle spells out the words' initials — `id`;
 * 5. the text contains it anywhere — `cremental`, from three characters up;
 * 6. some word is within the typo budget — `imcremental`;
 * 7. some word *starts* within the budget, so a partial may be misspelt too —
 *    `imcrem`.
 */
export function fuzzyScore(text: string, needle: string): number | null {
  const haystack = foldForSearch(text);
  const query = foldForSearch(needle);
  if (!query || !haystack) return null;

  if (haystack === query) return EXACT;
  if (haystack.startsWith(query)) return TEXT_PREFIX;

  const words = haystack.split(NON_WORD).filter(Boolean);

  let wordPrefixAt = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.startsWith(query)) {
      wordPrefixAt = i;
      break;
    }
  }
  if (wordPrefixAt >= 0) return WORD_PREFIX - positionPenalty(wordPrefixAt);

  // Initials only, so `id` reaches "Incremental Delivery" without `id` also
  // reaching every text that happens to hold those two letters in order. Tried
  // ahead of the infix below because naming a thing by its initials is
  // deliberate in a way that landing inside one of its words is not.
  if (query.length >= 2 && words.length >= 2) {
    const initials = words.map((word) => word[0]).join('');
    const acronymAt = initials.indexOf(query);
    if (acronymAt >= 0) return ACRONYM - positionPenalty(acronymAt);
  }

  // An infix needs three characters to mean anything. `in` sits inside most of
  // the English language — matching it mid-word returned 26 of 27 concepts and
  // buried the one the reader wanted nineteenth. Two characters therefore reach
  // only the tiers anchored to a word's start, which is what makes `in` a useful
  // way to ask for "Incremental Delivery" rather than for everything.
  if (query.length >= MIN_INFIX) {
    const at = haystack.indexOf(query);
    if (at >= 0) return SUBSTRING - positionPenalty(at);
  }

  const budget = typoBudget(query.length);
  if (budget === 0) return null;

  let best: number | null = null;
  for (const word of words) {
    const distance = boundedEditDistance(query, word, budget);
    if (distance <= budget) {
      const score = WORD_TYPO - distance * 10;
      if (best === null || score > best) best = score;
      // Nothing in this tier beats a distance of one edit, so stop looking.
      if (distance <= 1) break;
    }
  }
  if (best !== null) return best;

  // A misspelt *partial*: compare the needle against the head of each word.
  // Every head length within the budget is tried, because an inserted or
  // dropped character shifts where the needle stops lining up — `imcrem`
  // answers "incremental" only against a six-character head, not a seven.
  for (const word of words) {
    if (word.length <= query.length) continue;
    const shortest = Math.max(1, query.length - budget);
    const longest = Math.min(word.length, query.length + budget);
    for (let length = shortest; length <= longest; length++) {
      const distance = boundedEditDistance(query, word.slice(0, length), budget);
      if (distance > budget) continue;
      const score = PREFIX_TYPO - distance * 10;
      if (best === null || score > best) best = score;
      if (distance <= 1) break;
    }
    if (best !== null && best >= PREFIX_TYPO - 10) break;
  }
  return best;
}

/** Whether `text` answers `needle` at any tier. */
export function fuzzyMatches(text: string, needle: string): boolean {
  return fuzzyScore(text, needle) !== null;
}

/**
 * The combined score when **every** needle must be answered, or `null` when any
 * one of them is not. Terms are summed rather than maxed so a text answering
 * two of them outranks one answering either alone.
 */
export function fuzzyScoreAll(text: string, needles: readonly string[]): number | null {
  if (needles.length === 0) return 0;
  let total = 0;
  for (const needle of needles) {
    const score = fuzzyScore(text, needle);
    if (score === null) return null;
    total += score;
  }
  return total;
}

/** Whether `text` answers every needle. */
export function fuzzyMatchesAll(text: string, needles: readonly string[]): boolean {
  return fuzzyScoreAll(text, needles) !== null;
}

/** The lowest score a tier anchored to the start of a word can produce. */
const ANCHORED_FLOOR = ACRONYM - MAX_PENALTY;

/**
 * The combined score when every needle is answered **at the start of something**
 * — the whole text, a word in it, or the initials the words spell — and `null`
 * when any needle is answered only mid-word, only by a near-miss, or not at all.
 *
 * This is the difference between naming a thing and merely mentioning it, and it
 * is what a reader typing a fragment is doing. A relevance ranking computed over
 * a whole record cannot tell the two apart: bm25 put "incremental delivery"
 * nineteenth for `in`, behind every record whose prose happens to use the word.
 */
export function fuzzyAnchoredScoreAll(text: string, needles: readonly string[]): number | null {
  if (needles.length === 0) return null;
  let total = 0;
  for (const needle of needles) {
    const score = fuzzyScore(text, needle);
    if (score === null || score < ANCHORED_FLOOR) return null;
    total += score;
  }
  return total;
}

/**
 * The best score across several texts, or `null` when none of them answers.
 * Used where one record has many searchable fields and the reader is asking
 * about the record rather than about a field.
 */
export function fuzzyScoreBest(texts: readonly string[], needle: string): number | null {
  let best: number | null = null;
  for (const text of texts) {
    const score = fuzzyScore(text, needle);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}
