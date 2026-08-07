/**
 * Embedding projection of session transcripts — the flat map behind `/sessions/map`.
 *
 * Each transcript becomes one TF-IDF vector, every pair a cosine distance, and t-SNE lays those
 * out in two dimensions. Position is the entire claim: sessions about the same subject land near
 * each other. There are deliberately no edges — the session graph already draws parent/subagent,
 * and an edge here would read as a stronger claim than proximity supports.
 *
 * Two constraints carry the file:
 *
 * - **The command envelope is stripped before embedding.** A slash command's opening prompt
 *   inlines its whole definition, byte-identical across every run and dwarfing the criteria it
 *   wraps; embedding it would cluster `/task` with `/task` by boilerplate, so the map would only
 *   prove its own colouring. {@link parseCommandEnvelope} splits the two — the criteria is
 *   embedded, the command name kept aside as the label.
 * - **The vectors are TF-IDF, not neural.** This package has no runtime dependencies and no
 *   network; the projection must be reproducible offline from the transcripts already on disk.
 *
 * The pipeline is pure and seeded, so the same transcripts always produce the same map.
 */

import { type CommandEnvelope, parseCommandEnvelope } from './commands.js';
import { type SessionMeta, type SessionNode, sessionDisplayName } from './sessions.js';

// --- Input -----------------------------------------------------------------

/**
 * One transcript, as much of it as the projection reads. A `SessionGraph` row satisfies this
 * structurally, so the server passes its listing straight in.
 */
export interface ProjectableSession extends SessionMeta {
  /** The transcript's ordered steps — the bulk of the text that gets embedded. */
  nodes: readonly SessionNode[];
  /** Last-modified time, ISO 8601 (UTC). */
  modified: string;
}

// --- Text ------------------------------------------------------------------

/**
 * English function words. Deliberately short — corpus-specific noise is dropped by
 * {@link TFIDF_DEFAULTS}'s document-frequency ceiling instead, which adapts as the corpus changes.
 */
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'both',
  'but',
  'can',
  'cannot',
  'could',
  'did',
  'does',
  'doing',
  'done',
  'each',
  'either',
  'else',
  'every',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'however',
  'into',
  'its',
  'itself',
  'just',
  'like',
  'made',
  'make',
  'many',
  'may',
  'might',
  'more',
  'most',
  'much',
  'must',
  'need',
  'neither',
  'nor',
  'not',
  'now',
  'off',
  'once',
  'one',
  'only',
  'onto',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'per',
  'rather',
  'same',
  'shall',
  'she',
  'should',
  'since',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'though',
  'through',
  'thus',
  'too',
  'under',
  'until',
  'upon',
  'use',
  'used',
  'using',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'within',
  'without',
  'would',
  'you',
  'your',
  'yours',
]);

/** A term: letters first, so a bare number or an offset never becomes one. */
const TERM_RE = /[a-z][a-z0-9]*/g;
/** Shortest term kept — below this a token is a fragment of a path, not a subject. */
const MIN_TERM_CHARS = 3;
/** Longest term kept. Past it a token is a hash, a base64 blob, or a minified identifier. */
const MAX_TERM_CHARS = 24;
/** A thread id, sha, or other hex blob — the same subject with a different id is not a different subject. */
const HEX_BLOB_RE = /^[0-9a-f]{8,}$/;

/**
 * Split text into embedding terms: lowercase, letter-led runs of at least
 * {@link MIN_TERM_CHARS}, minus stop words, hex blobs, and anything implausibly long.
 * `camelCase` and `snake_case` fall apart into their words, so a transcript's tool signatures
 * contribute their paths as subject terms.
 */
export function embeddingTerms(text: string): string[] {
  const terms: string[] = [];
  // Split on the case boundary *before* lowercasing — after it there is no boundary left to see.
  const split = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const match of split.matchAll(TERM_RE)) {
    const term = match[0];
    if (term.length < MIN_TERM_CHARS || term.length > MAX_TERM_CHARS) continue;
    if (STOP_WORDS.has(term) || HEX_BLOB_RE.test(term)) continue;
    terms.push(term);
  }
  return terms;
}

/** How much node text one session contributes. A long run would otherwise dominate the vocabulary. */
const NODE_TEXT_BUDGET = 20_000;

/**
 * The text a session is embedded from: its names, its criteria, and its steps, with the slash
 * command's inlined definition removed. A command run contributes {@link CommandEnvelope.prompt};
 * an ordinary session contributes its subtitle as written.
 */
export function sessionSubjectText(session: ProjectableSession): string {
  const envelope = parseCommandEnvelope(session.subtitle) ?? parseCommandEnvelope(session.firstTask);
  const parts: string[] = [];
  if (session.title) parts.push(session.title);
  if (session.derivedTitle) parts.push(session.derivedTitle);
  // The criteria, never the definition — see the file header.
  if (envelope) parts.push(envelope.prompt);
  else if (session.subtitle) parts.push(session.subtitle);

  let budget = NODE_TEXT_BUDGET;
  for (const node of session.nodes) {
    if (budget <= 0) break;
    const text = node.text.slice(0, budget);
    parts.push(text);
    budget -= text.length;
  }
  return parts.join('\n');
}

/** The slash command a session ran, without its leading slash, or null for an ordinary session. */
export function sessionCommand(session: ProjectableSession): string | null {
  const envelope = parseCommandEnvelope(session.subtitle) ?? parseCommandEnvelope(session.firstTask);
  return envelope?.command ?? null;
}

/** Words a criteria-derived name keeps, and its hard character cap. */
const NAME_WORDS = 9;
const NAME_CHARS = 72;

/**
 * Condense a run's criteria into a name: drop its flags, then keep the first {@link NAME_WORDS}
 * words, with an `…` marking the cut.
 *
 * Every flag token goes, wherever it sits, since a leading run of them would eat the whole word
 * budget. A flag's *value* is not recognised as belonging to it — nothing here knows which flags
 * take one (the limitation `parseCommandEnvelope` records for its own flag list) — so a value can
 * survive as a leading word. Cosmetic in a name rather than misleading.
 */
function condenseCriteria(prompt: string): string {
  const words = prompt.split(/\s+/).filter((word) => word !== '' && !word.startsWith('-'));
  const kept = words.slice(0, NAME_WORDS);
  const name = kept.join(' ');
  if (name.length > NAME_CHARS) return `${name.slice(0, NAME_CHARS).trimEnd()}…`;
  return words.length > kept.length ? `${name}…` : name;
}

/**
 * The name a dot carries. {@link sessionDisplayName} is the authority, but for a command run it
 * often comes back as the bare command — `deriveSessionName` keeps only the first sentence of the
 * opening prompt, and a run whose args start with flags or span several lines collapses to just
 * `/task`, which says nothing the dot's colour does not. Where it adds nothing, the criteria is
 * appended to identify the session.
 */
function pointName(session: ProjectableSession, envelope: CommandEnvelope | null): string {
  const display = sessionDisplayName(session);
  if (!envelope) return display;
  // Whatever the display name carries beyond the command token itself.
  const beyond = display.replace(/^\/?[\w:-]+/, '').trim();
  if (beyond !== '') return display;
  const criteria = condenseCriteria(envelope.prompt);
  return criteria === '' ? display : `/${envelope.command} · ${criteria}`;
}

// --- TF-IDF ----------------------------------------------------------------

/** A sparse, L2-normalized embedding vector: term → weight. */
export type EmbeddingVector = Map<string, number>;

export interface TfIdfOptions {
  /**
   * Drop a term appearing in fewer than this many documents — a term in one document cannot bring
   * two sessions together. Applied only above {@link MIN_DOCS_FOR_DF_FLOOR} documents.
   */
  minDocumentFrequency?: number;
  /**
   * Drop a term appearing in more than this fraction of documents. Removes the corpus's own
   * boilerplate without a hand-maintained list.
   */
  maxDocumentFrequencyRatio?: number;
  /** Keep at most this many terms, the most-discriminating first, so the vocabulary is bounded. */
  maxTerms?: number;
}

/** Below this many documents, a document-frequency floor would empty the vocabulary. */
const MIN_DOCS_FOR_DF_FLOOR = 5;

export const TFIDF_DEFAULTS = {
  minDocumentFrequency: 2,
  maxDocumentFrequencyRatio: 0.5,
  maxTerms: 4_000,
} as const satisfies Required<TfIdfOptions>;

export interface TfIdfResult {
  /** One L2-normalized vector per input document, in input order. */
  vectors: EmbeddingVector[];
  /** The kept terms, most-discriminating first. */
  vocabulary: string[];
}

/**
 * Build L2-normalized TF-IDF vectors for a corpus of pre-tokenized documents.
 *
 * Term frequency is sublinear (`1 + ln tf`), so a repeated word does not outweigh distinct ones;
 * inverse document frequency is smoothed (`ln(1 + N/df)`), so a term in every document keeps a
 * little weight. L2 normalization makes the dot product the cosine similarity.
 */
export function buildTfIdf(documents: readonly (readonly string[])[], options: TfIdfOptions = {}): TfIdfResult {
  const { minDocumentFrequency, maxDocumentFrequencyRatio, maxTerms } = { ...TFIDF_DEFAULTS, ...options };
  const total = documents.length;
  if (total === 0) return { vectors: [], vocabulary: [] };

  const counts: Map<string, number>[] = documents.map((terms) => {
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    return tf;
  });

  const df = new Map<string, number>();
  for (const tf of counts) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);

  const floor = total >= MIN_DOCS_FOR_DF_FLOOR ? minDocumentFrequency : 1;
  const ceiling = Math.max(1, Math.floor(total * maxDocumentFrequencyRatio));
  const kept = [...df.entries()].filter(([, n]) => n >= floor && n <= ceiling);
  // Rarer is more discriminating; the tie-break is alphabetical so the cut is deterministic.
  kept.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const vocabulary = kept.slice(0, maxTerms).map(([term]) => term);
  const idf = new Map(vocabulary.map((term) => [term, Math.log(1 + total / df.get(term)!)]));

  const vectors = counts.map((tf) => {
    const vector: EmbeddingVector = new Map();
    for (const [term, n] of tf) {
      const weight = idf.get(term);
      if (weight === undefined) continue;
      vector.set(term, (1 + Math.log(n)) * weight);
    }
    let norm = 0;
    for (const weight of vector.values()) norm += weight * weight;
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [term, weight] of vector) vector.set(term, weight / norm);
    return vector;
  });

  return { vectors, vocabulary };
}

/**
 * Cosine distance between two L2-normalized sparse vectors, in `[0, 2]`. Iterates the smaller
 * vector, so a short session costs little against a long one.
 */
export function cosineDistance(a: EmbeddingVector, b: EmbeddingVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  return 1 - dot;
}

// --- t-SNE -----------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — the projection must be reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, for the tiny gaussian the layout starts from. */
function gaussian(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export interface TsneOptions {
  /**
   * Roughly how many neighbours each point tries to keep. Clamped against the corpus size —
   * a perplexity approaching N makes every point everyone's neighbour and the map collapses.
   */
  perplexity?: number;
  iterations?: number;
  /** Seeds the initial layout. Same seed, same map. */
  seed?: number;
  /** Defaults to {@link autoLearningRate} for the corpus size; set it only to override that. */
  learningRate?: number;
  /** How much the early iterations exaggerate P, opening space between clusters before they settle. */
  earlyExaggeration?: number;
  /** Iterations the exaggeration applies for. */
  exaggerationIterations?: number;
}

export const TSNE_DEFAULTS = {
  perplexity: 18,
  iterations: 600,
  seed: 42,
  earlyExaggeration: 4,
  exaggerationIterations: 150,
} as const satisfies Required<Omit<TsneOptions, 'learningRate'>>;

/** The floor the auto learning rate never drops below, for a corpus small enough to want less. */
const MIN_LEARNING_RATE = 50;

/**
 * The learning rate for a corpus of `n` points — scikit-learn's `learning_rate="auto"` rule,
 * `max(n / exaggeration / 4, 50)`.
 *
 * The rate is not scale-free: the gradient sums over every pair, so a step sized for thousands of
 * points overshoots on dozens and leaves clusters oscillating instead of settling. A fixed 200 was
 * measured diverging at 60 points while every rate at 100 and below converged.
 */
export function autoLearningRate(n: number, earlyExaggeration: number = TSNE_DEFAULTS.earlyExaggeration): number {
  return Math.max(n / earlyExaggeration / 4, MIN_LEARNING_RATE);
}

export interface TsnePoint {
  x: number;
  y: number;
}

/** Iterations of the per-point bandwidth search, and how close its entropy must land. */
const BETA_SEARCH_STEPS = 60;
const BETA_TOLERANCE = 1e-5;

/**
 * The largest perplexity a corpus of `n` points supports. t-SNE needs each point's neighbour
 * distribution to be narrower than the corpus itself; the conventional bound is `3 × perplexity
 * < n`, and below four points the notion stops meaning anything.
 */
export function clampPerplexity(requested: number, n: number): number {
  return Math.max(1, Math.min(requested, Math.max(1, (n - 1) / 3)));
}

/**
 * Per-point conditional neighbour probabilities at a target perplexity, symmetrized into the
 * joint distribution P that t-SNE matches.
 *
 * Each row gets its own gaussian bandwidth, found by bisection on `beta = 1/2σ²` until the row's
 * Shannon entropy hits `log(perplexity)`, so a point in a dense cluster and one out on its own
 * keep comparable neighbour counts.
 *
 * **The target is not always reachable, so the kept row is the closest one, not the last tried.**
 * Where a point's `k` nearest neighbours sit at identical distances, entropy bottoms out at
 * `log k`; a perplexity below that drives `beta` up until `exp(-d·beta)` underflows to zero for
 * every neighbour. Treating that underflow as "still too wide" widens the search further and
 * yields a uniform row — the one answer that erases all structure. Underflow therefore lowers the
 * ceiling instead, and each step is scored against the target with the best kept.
 */
function jointProbabilities(squared: readonly (readonly number[])[], perplexity: number): Float64Array {
  const n = squared.length;
  const p = new Float64Array(n * n);
  const target = Math.log(perplexity);
  const row = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let beta = 1;
    let min = 0;
    let max = Number.POSITIVE_INFINITY;
    const distances = squared[i]!;
    /** How far the best row found so far lands from the target entropy. */
    let bestGap = Number.POSITIVE_INFINITY;

    for (let step = 0; step < BETA_SEARCH_STEPS; step++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const value = i === j ? 0 : Math.exp(-distances[j]! * beta);
        row[j] = value;
        sum += value;
      }
      if (sum <= 0) {
        // Every neighbour underflowed, so this bandwidth is too *narrow* to say anything:
        // it bounds the search from above.
        max = beta;
        beta = (beta + min) / 2;
        continue;
      }

      // Entropy of the normalized row, computed without materializing it.
      let weighted = 0;
      for (let j = 0; j < n; j++) weighted += distances[j]! * row[j]!;
      const entropy = Math.log(sum) + beta * (weighted / sum);

      const gap = Math.abs(entropy - target);
      if (gap < bestGap) {
        bestGap = gap;
        for (let j = 0; j < n; j++) p[i * n + j] = row[j]! / sum;
      }
      if (gap < BETA_TOLERANCE) break;

      if (entropy > target) {
        // Too many effective neighbours — narrow the kernel.
        min = beta;
        beta = max === Number.POSITIVE_INFINITY ? beta * 2 : (beta + max) / 2;
      } else {
        max = beta;
        beta = (beta + min) / 2;
      }
    }

    if (bestGap === Number.POSITIVE_INFINITY) {
      // Every bandwidth tried underflowed — spread the row evenly rather than dropping the
      // point off the map with a row of zeroes.
      const uniform = n > 1 ? 1 / (n - 1) : 0;
      for (let j = 0; j < n; j++) p[i * n + j] = i === j ? 0 : uniform;
    }
  }

  // Symmetrize and normalize so the joint distribution sums to 1 over all pairs.
  const joint = new Float64Array(n * n);
  const scale = 2 * n;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const value = (p[i * n + j]! + p[j * n + i]!) / scale;
      joint[i * n + j] = value;
      joint[j * n + i] = value;
    }
  }
  return joint;
}

/**
 * Lay a precomputed distance matrix out in two dimensions with t-SNE.
 *
 * `squared` holds squared distances. The optimizer is the standard one — early exaggeration,
 * momentum stepping 0.5 → 0.8, per-parameter gains — over the full O(n²) gradient rather than
 * Barnes-Hut, which stays within budget at a log directory's scale and is exactly reproducible.
 *
 * Output is centered and scaled so the widest axis spans `[-1, 1]`; the caller maps that to pixels.
 */
export function tsne(squared: readonly (readonly number[])[], options: TsneOptions = {}): TsnePoint[] {
  const { perplexity, iterations, seed, earlyExaggeration, exaggerationIterations } = {
    ...TSNE_DEFAULTS,
    ...options,
  };
  const n = squared.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  const learningRate = options.learningRate ?? autoLearningRate(n, earlyExaggeration);

  const p = jointProbabilities(squared, clampPerplexity(perplexity, n));
  const random = mulberry32(seed);
  // A tiny gaussian: t-SNE's early iterations do the spreading, and a wide start fights them.
  const y = new Float64Array(n * 2);
  for (let i = 0; i < n * 2; i++) y[i] = gaussian(random) * 1e-4;

  const gradient = new Float64Array(n * 2);
  const velocity = new Float64Array(n * 2);
  const gains = new Float64Array(n * 2).fill(1);
  const affinity = new Float64Array(n * n);

  for (let iteration = 0; iteration < iterations; iteration++) {
    // Q, the low-dimensional affinities, under a Student-t kernel with one degree of freedom.
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = y[i * 2]! - y[j * 2]!;
        const dy = y[i * 2 + 1]! - y[j * 2 + 1]!;
        const value = 1 / (1 + dx * dx + dy * dy);
        affinity[i * n + j] = value;
        affinity[j * n + i] = value;
        sum += 2 * value;
      }
    }
    if (sum <= 0) sum = Number.MIN_VALUE;

    const exaggeration = iteration < exaggerationIterations ? earlyExaggeration : 1;
    gradient.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const joint = p[i * n + j]!;
        const q = affinity[i * n + j]!;
        // `4 ×` is the analytic constant of the KL gradient under the t-kernel.
        const force = 4 * (exaggeration * joint - q / sum) * q;
        gradient[i * 2] = gradient[i * 2]! + force * (y[i * 2]! - y[j * 2]!);
        gradient[i * 2 + 1] = gradient[i * 2 + 1]! + force * (y[i * 2 + 1]! - y[j * 2 + 1]!);
      }
    }

    const momentum = iteration < exaggerationIterations ? 0.5 : 0.8;
    for (let i = 0; i < n * 2; i++) {
      // A gain rises while the gradient keeps its sign and is cut when it flips — the standard
      // per-parameter step adaptation.
      const aligned = Math.sign(gradient[i]!) === Math.sign(velocity[i]!);
      gains[i] = Math.max(0.01, aligned ? gains[i]! * 0.8 : gains[i]! + 0.2);
      velocity[i] = momentum * velocity[i]! - learningRate * gains[i]! * gradient[i]!;
      y[i] = y[i]! + velocity[i]!;
    }

    // Re-center every iteration, so the cloud cannot drift away from the origin.
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      cx += y[i * 2]!;
      cy += y[i * 2 + 1]!;
    }
    cx /= n;
    cy /= n;
    for (let i = 0; i < n; i++) {
      y[i * 2] = y[i * 2]! - cx;
      y[i * 2 + 1] = y[i * 2 + 1]! - cy;
    }
  }

  // Scale the widest axis to [-1, 1]. A cloud that collapsed to a point stays at the origin.
  let extent = 0;
  for (let i = 0; i < n * 2; i++) extent = Math.max(extent, Math.abs(y[i]!));
  const scale = extent > 0 ? 1 / extent : 0;
  const points: TsnePoint[] = [];
  for (let i = 0; i < n; i++) points.push({ x: y[i * 2]! * scale, y: y[i * 2 + 1]! * scale });
  return points;
}

// --- The projection --------------------------------------------------------

/** One session as a dot on the map. */
export interface SessionPoint {
  threadId: string;
  /** The most human name the transcript offers — what the tooltip leads with. */
  name: string;
  /** The slash command that ran it, without its slash, or null for an ordinary session. */
  command: string | null;
  /** Projected position, each axis in `[-1, 1]`. Position is the whole meaning. */
  x: number;
  y: number;
  /** The highest-weighted terms behind this vector — why the dot sits where it does. */
  terms: string[];
  model: string | null;
  started: string | null;
  modified: string;
  tasks: number;
  tools: number;
  errors: number;
}

/** How many sessions ran each command, for the legend. Ranked, commonest first. */
export interface CommandBand {
  /** The command without its slash, or null for the ordinary-session band. */
  command: string | null;
  sessions: number;
}

export interface SessionProjection {
  points: SessionPoint[];
  /** The legend: every command on the map, commonest first, with `null` last. */
  commands: CommandBand[];
  meta: {
    /** Sessions actually projected. */
    sessions: number;
    /** Sessions dropped for holding no usable text — an empty or header-only transcript. */
    skipped: number;
    vocabulary: number;
    /** The perplexity actually used, after clamping against the corpus size. */
    perplexity: number;
    iterations: number;
    seed: number;
  };
}

export interface ProjectSessionsOptions extends TsneOptions, TfIdfOptions {
  /** How many top terms each point reports. */
  termsPerPoint?: number;
}

/** Terms named per point in the tooltip. */
const DEFAULT_TERMS_PER_POINT = 6;

/**
 * Project a corpus of transcripts onto the flat map: embed each one, take every pairwise cosine
 * distance, and reduce to two dimensions with t-SNE.
 *
 * A session whose text yields no terms is **skipped rather than placed at the origin** — parking
 * a subject-less transcript somewhere specific would invent a claim and pull real clusters toward
 * the middle. `meta.skipped` reports how many.
 */
export function projectSessions(
  sessions: readonly ProjectableSession[],
  options: ProjectSessionsOptions = {},
): SessionProjection {
  const { termsPerPoint = DEFAULT_TERMS_PER_POINT, ...rest } = options;

  const candidates = sessions.map((session) => ({
    session,
    terms: embeddingTerms(sessionSubjectText(session)),
  }));
  const usable = candidates.filter((c) => c.terms.length > 0);
  const skipped = candidates.length - usable.length;

  const { vectors, vocabulary } = buildTfIdf(
    usable.map((c) => c.terms),
    rest,
  );
  // A session whose every term was filtered out of the vocabulary has an empty vector, which
  // is equidistant from everything; it still belongs on the map, just with nothing pinning it.
  const squared = vectors.map((a) =>
    vectors.map((b) => {
      const distance = cosineDistance(a, b);
      return distance * distance;
    }),
  );

  const perplexity = clampPerplexity(rest.perplexity ?? TSNE_DEFAULTS.perplexity, usable.length);
  const iterations = rest.iterations ?? TSNE_DEFAULTS.iterations;
  const seed = rest.seed ?? TSNE_DEFAULTS.seed;
  const laid = tsne(squared, { ...rest, perplexity, iterations, seed });

  const points: SessionPoint[] = usable.map(({ session }, i) => {
    const vector = vectors[i]!;
    const top = [...vector.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, termsPerPoint)
      .map(([term]) => term);
    const envelope = parseCommandEnvelope(session.subtitle) ?? parseCommandEnvelope(session.firstTask);
    return {
      threadId: session.threadId,
      name: pointName(session, envelope),
      command: envelope?.command ?? null,
      x: laid[i]?.x ?? 0,
      y: laid[i]?.y ?? 0,
      terms: top,
      model: session.model,
      started: session.started,
      modified: session.modified,
      tasks: session.tasks,
      tools: session.tools,
      errors: session.errors,
    };
  });

  const counts = new Map<string | null, number>();
  for (const point of points) counts.set(point.command, (counts.get(point.command) ?? 0) + 1);
  const commands = [...counts.entries()]
    .map(([command, sessions]) => ({ command, sessions }))
    // Commonest first; the ordinary-session band sorts last whatever its size.
    .sort((a, b) => {
      if (a.command === null) return 1;
      if (b.command === null) return -1;
      return b.sessions - a.sessions || a.command.localeCompare(b.command);
    });

  return {
    points,
    commands,
    meta: {
      sessions: points.length,
      skipped,
      vocabulary: vocabulary.length,
      perplexity,
      iterations,
      seed,
    },
  };
}
