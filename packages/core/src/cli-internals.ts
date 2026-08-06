/**
 * CLI internals — a catalogue of functions inside the installed Claude Code bundle,
 * resolved out of the bundle text at read time.
 *
 * The bundle ships minified, so every identifier in it (`GEe`, `wat`, `N_p`) is a
 * compiler artefact that changes between releases. Nothing here is keyed to a name.
 * Each catalogue entry carries a **stable signal** instead, and the resolver reports
 * whatever identifier the installed version happens to have given the function it
 * finds. Where the signal is gone, the entry resolves to a miss rather than to the
 * wrong function.
 *
 * Two signals, because the bundle offers two:
 *   - a **string literal** the function contains — prompt text, a log prefix, the
 *     property name it reads — walked outwards to the function enclosing it;
 *   - an **export name**, from the `it(M,{name:()=>ident})` maps the bundler emits.
 *     These keep their source spelling, so `isForkSubagentEnabled:()=>GEe` hands the
 *     minified name over directly.
 *
 * Pure: no I/O — the server locates the bundle, reads it, and passes the text in.
 * Read it as latin1 so one character is one byte, which lets the offsets reported
 * here serve as byte offsets for a later ranged read of the source itself.
 */

/** How an entry failed to resolve against the installed bundle. */
export type CliFunctionMiss =
  /** The signal is not in this bundle at all. */
  | 'signal-missing'
  /** The literal is there, but never in the shape `near` requires. */
  | 'no-match-nearby'
  /** The signal resolved to an offset, but no function could be parsed around it. */
  | 'no-enclosing-function';

/** What identifies a function independently of what it was minified to. */
export type CliFunctionSignal =
  | {
      kind: 'literal';
      /** Text the bundle still contains verbatim. */
      literal: string;
      /**
       * Source of a regular expression the literal's neighbourhood must match, for
       * a literal several functions share. The match has to cover the occurrence
       * itself, so a getter and its adjacent setter stay apart. Names no minified
       * identifier — that is the thing that moves.
       */
      near?: string;
    }
  | {
      kind: 'export';
      /** The source-spelled name in a bundler export map, `name:()=>ident`. */
      exportName: string;
    };

/** One catalogued function, described by what identifies it rather than by its name. */
export interface CliFunctionAnchor {
  /** Stable id — the catalogue's own key, and the detail page's URL segment. */
  id: string;
  /** What the function is, in the story it belongs to. */
  label: string;
  /** One line on what the body actually does, written from the bundle. */
  description: string;
  /** How to find it in a bundle that has renamed it. */
  signal: CliFunctionSignal;
  /**
   * How many enclosing functions to step out past the innermost one. A literal
   * inside a nested callback resolves to that callback at 0, to its host at 1.
   * Literal signals only.
   */
  outward?: number;
}

/** A catalogue entry resolved against one installed bundle. */
export interface CliFunctionEntry extends CliFunctionAnchor {
  /** The identifier this version minified the function to, or null on a miss. */
  name: string | null;
  /** `name(params)` as the bundle spells it, or null on a miss. */
  signature: string | null;
  /** Byte offset of the function's first character, for a ranged read. */
  offset: number | null;
  /** Length in bytes of the extracted source. */
  length: number | null;
  /** Null when the entry resolved; otherwise why it did not. */
  missing: CliFunctionMiss | null;
}

/** A function located in the bundle text. */
export interface ExtractedFunction {
  /** The identifier the bundle gives it, or null for a function with no name. */
  name: string | null;
  /** The parameter list as written, without the surrounding parentheses. */
  params: string;
  /** Offset of the function's first character in the text it was found in. */
  start: number;
  /** Offset one past its last character. */
  end: number;
  /** The source text, verbatim. */
  source: string;
}

/**
 * How far back from an anchor a function head may start. Bundled functions are far
 * smaller than this; the bound keeps a miss cheap rather than scanning the whole
 * bundle backwards.
 */
const HEAD_WINDOW = 500_000;

/** How far a balanced scan may run before the input is treated as malformed. */
const MAX_SCAN = 4_000_000;

/** How many occurrences of a literal to try before giving up on it. */
const MAX_OCCURRENCES = 40;

/** How much text either side of an occurrence `near` is tested against. */
const NEAR_WINDOW = 200;

/**
 * Walk a balanced bracket run starting at `openIndex`, which must be `(`, `[` or `{`.
 * Returns the offset one past the matching close, or null if it never closes.
 *
 * String, template and regex literals are skipped rather than counted, since a brace
 * inside one is not structure — `${…}` interpolations are re-entered as code, which
 * is what makes a template-heavy prompt builder scan correctly.
 */
export function scanBalanced(text: string, openIndex: number): number | null {
  const open = text[openIndex];
  if (open !== '(' && open !== '[' && open !== '{') return null;

  /** Code frames count brackets; a template frame is inside a backtick literal. */
  const frames: ({ kind: 'code'; depth: number } | { kind: 'template' })[] = [{ kind: 'code', depth: 0 }];
  let i = openIndex;
  let prev = '';
  const limit = Math.min(text.length, openIndex + MAX_SCAN);

  while (i < limit) {
    const frame = frames[frames.length - 1]!;
    const c = text[i]!;

    if (frame.kind === 'template') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        frames.pop();
        i++;
        prev = '`';
        continue;
      }
      if (c === '$' && text[i + 1] === '{') {
        frames.push({ kind: 'code', depth: 0 });
        i += 2;
        prev = '';
        continue;
      }
      i++;
      continue;
    }

    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(text, i, c);
      if (end === null) return null;
      i = end;
      prev = '"';
      continue;
    }
    if (c === '`') {
      frames.push({ kind: 'template' });
      i++;
      continue;
    }
    if (c === '/' && regexAllowedAfter(text, i, prev)) {
      const end = skipRegex(text, i);
      if (end === null) return null;
      i = end;
      prev = '/';
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      frame.depth++;
      i++;
      prev = c;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      // A `}` closing an interpolation has no opener on this frame — it ends it.
      if (c === '}' && frame.depth === 0 && frames.length > 1) {
        frames.pop();
        i++;
        continue;
      }
      frame.depth--;
      i++;
      prev = c;
      if (frame.depth === 0 && frames.length === 1) return i;
      if (frame.depth < 0) return null;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return null;
}

/** Offset one past a `'`/`"` string starting at `start`, or null if unterminated. */
function skipQuoted(text: string, start: number, quote: string): number | null {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === quote) return i + 1;
  }
  return null;
}

/** Offset one past a regex literal (flags included) starting at `start`. */
function skipRegex(text: string, start: number): number | null {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let j = i + 1;
      while (j < text.length && /[a-z]/.test(text[j]!)) j++;
      return j;
    } else if (c === '\n') return null;
  }
  return null;
}

/** Keywords after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Whether a `/` at `index` starts a regex. After a value — an identifier, a number,
 * or a closing bracket — it is division; after an operator or a keyword like
 * `return` it is a literal.
 */
function regexAllowedAfter(text: string, index: number, prev: string): boolean {
  if (prev === '') return true;
  if (prev === ')' || prev === ']' || prev === '}') return false;
  if (!/[\w$]/.test(prev)) return true;
  // The previous token is a word: a keyword allows a regex, a value does not.
  let end = index;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;
  let begin = end;
  while (begin > 0 && /[\w$]/.test(text[begin - 1]!)) begin--;
  return REGEX_PRECEDING_KEYWORDS.has(text.slice(begin, end));
}

/** A parsed function head, before its body has been matched. */
interface FunctionHead {
  /** Offset of the first character to include in the extracted source. */
  start: number;
  /** Name from the head itself, or null when it has to come from an assignment. */
  name: string | null;
  /** Offset of the `(` opening the parameter list, or null for a bare arrow param. */
  parenIndex: number | null;
  /** Offset of the single bare arrow parameter, when there is no parameter list. */
  bareParamStart: number | null;
  /** Offset one past the head's last matched character. */
  headEnd: number;
}

/**
 * The three head shapes a bundler emits: a `function` keyword (named or not), an
 * identifier assigned a parenthesised function or arrow, and an identifier assigned
 * a single-parameter arrow.
 */
const FUNCTION_HEAD =
  /(?:\b(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\()|(?:\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()|(?:\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>)/g;

/** Function heads in `text[from, to)`, in source order. */
function functionHeads(text: string, from: number, to: number): FunctionHead[] {
  const window = text.slice(from, to);
  const heads: FunctionHead[] = [];
  FUNCTION_HEAD.lastIndex = 0;
  for (;;) {
    const m = FUNCTION_HEAD.exec(window);
    if (m === null) break;
    const start = from + m.index;
    const headEnd = start + m[0].length;
    if (m[3] !== undefined) {
      // `x=e=>` — the parameter is a bare identifier and `=>` is already consumed.
      heads.push({
        start,
        name: m[3],
        parenIndex: null,
        bareParamStart: start + m[0].lastIndexOf(m[4]!),
        headEnd,
      });
      continue;
    }
    heads.push({ start, name: m[1] ?? m[2] ?? null, parenIndex: headEnd - 1, bareParamStart: null, headEnd });
  }
  return heads;
}

/** An anonymous head takes its name from the `x=` it is assigned to, if any. */
function nameFromAssignment(text: string, start: number): string | null {
  let i = start;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  if (text[i - 1] !== '=' || text[i - 2] === '=' || text[i - 2] === '!' || text[i - 2] === '>') return null;
  i--;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  const end = i;
  while (i > 0 && /[\w$]/.test(text[i - 1]!)) i--;
  return i === end ? null : text.slice(i, end);
}

/** Complete a head into a function, or null when it has no braced body. */
function completeHead(text: string, head: FunctionHead): ExtractedFunction | null {
  let params: string;
  let afterParams: number;

  if (head.parenIndex === null) {
    // `x=e=>{…}`: the head already runs through the `=>`.
    params = text.slice(head.bareParamStart!, head.headEnd - 2).trim();
    afterParams = head.headEnd;
  } else {
    const close = scanBalanced(text, head.parenIndex);
    if (close === null) return null;
    params = text.slice(head.parenIndex + 1, close - 1);
    afterParams = close;
  }

  let i = afterParams;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === '=' && text[i + 1] === '>') {
    i += 2;
    while (i < text.length && /\s/.test(text[i]!)) i++;
  } else if (head.parenIndex !== null && head.name === null && text[i] !== '{') {
    // `x=(a+b)` is a parenthesised expression, not a function.
    return null;
  }
  // An arrow with an expression body has no braces to delimit it; skip it.
  if (text[i] !== '{') return null;

  const end = scanBalanced(text, i);
  if (end === null) return null;

  return {
    name: head.name ?? nameFromAssignment(text, head.start),
    params,
    start: head.start,
    end,
    source: text.slice(head.start, end),
  };
}

/**
 * The function whose body contains `index`, stepping `outward` levels past the
 * innermost one. Returns null when nothing parses around the offset — which is what
 * happens when the offset lands in a data section rather than in code.
 */
export function extractEnclosingFunction(text: string, index: number, outward = 0): ExtractedFunction | null {
  const from = Math.max(0, index - HEAD_WINDOW);
  const heads = functionHeads(text, from, index);
  let remaining = outward;
  // Innermost first: the nearest head that still closes after `index` encloses it.
  for (let i = heads.length - 1; i >= 0; i--) {
    const fn = completeHead(text, heads[i]!);
    if (fn === null || fn.end <= index) continue;
    if (remaining === 0) return fn;
    remaining--;
  }
  return null;
}

/** Escape a name for embedding in a regular expression. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The minified identifier a bundler export map binds `exportName` to, from the
 * `it(M,{exportName:()=>ident})` form, or null when this bundle exports no such name.
 */
export function resolveExportedName(text: string, exportName: string): string | null {
  const m = new RegExp(`\\b${escapeRe(exportName)}\\s*:\\s*\\(\\s*\\)\\s*=>\\s*([A-Za-z_$][\\w$]*)`).exec(text);
  return m === null ? null : m[1]!;
}

/** The `function <name>(…){…}` declaration for an identifier, or null if it has none. */
export function extractFunctionDeclaration(text: string, name: string): ExtractedFunction | null {
  const re = new RegExp(`\\b(?:async\\s+)?function\\b\\s*\\*?\\s*${escapeRe(name)}\\s*\\(`, 'g');
  for (;;) {
    const m = re.exec(text);
    if (m === null) return null;
    const fn = completeHead(text, {
      start: m.index,
      name,
      parenIndex: m.index + m[0].length - 1,
      bareParamStart: null,
      headEnd: m.index + m[0].length,
    });
    if (fn !== null) return fn;
  }
}

/** Whether some match of `near` in the window covers the occurrence itself. */
function nearCovers(text: string, at: number, near: RegExp): boolean {
  const from = Math.max(0, at - NEAR_WINDOW);
  const window = text.slice(from, at + NEAR_WINDOW);
  const target = at - from;
  const scan = new RegExp(near.source, near.flags.includes('g') ? near.flags : `${near.flags}g`);
  for (;;) {
    const m = scan.exec(window);
    if (m === null) return false;
    if (m.index <= target && target < m.index + m[0].length) return true;
    // A zero-length match would spin here; step past it.
    if (m[0].length === 0) scan.lastIndex++;
  }
}

/**
 * Resolve one catalogue entry against the bundle text.
 *
 * For a literal, every occurrence is tried rather than just the first: a compiled
 * bundle carries its string constants in a data section as well as in the code, so
 * the first hit is routinely one that no function encloses. The first occurrence
 * that parses wins.
 */
export function resolveCliFunction(text: string, anchor: CliFunctionAnchor): CliFunctionEntry {
  const miss = (reason: CliFunctionMiss): CliFunctionEntry => ({
    ...anchor,
    name: null,
    signature: null,
    offset: null,
    length: null,
    missing: reason,
  });
  const hit = (fn: ExtractedFunction): CliFunctionEntry => ({
    ...anchor,
    name: fn.name,
    signature: `${fn.name ?? '(anonymous)'}(${fn.params})`,
    offset: fn.start,
    length: fn.end - fn.start,
    missing: null,
  });

  if (anchor.signal.kind === 'export') {
    const name = resolveExportedName(text, anchor.signal.exportName);
    if (name === null) return miss('signal-missing');
    const fn = extractFunctionDeclaration(text, name);
    return fn === null ? miss('no-enclosing-function') : hit(fn);
  }

  const { literal, near } = anchor.signal;
  if (literal === '') return miss('signal-missing');
  const shape = near === undefined ? null : new RegExp(near);

  let sawShape = false;
  let at = text.indexOf(literal);
  if (at === -1) return miss('signal-missing');
  for (let tried = 0; at !== -1 && tried < MAX_OCCURRENCES; tried++) {
    if (shape === null || nearCovers(text, at, shape)) {
      sawShape = true;
      const fn = extractEnclosingFunction(text, at, anchor.outward ?? 0);
      if (fn !== null) return hit(fn);
    }
    at = text.indexOf(literal, at + 1);
  }
  return miss(sawShape ? 'no-enclosing-function' : 'no-match-nearby');
}

/** Resolve the whole catalogue in one pass over the bundle text. */
export function resolveCliCatalogue(
  text: string,
  catalogue: readonly CliFunctionAnchor[] = CLI_FUNCTION_CATALOGUE,
): CliFunctionEntry[] {
  return catalogue.map((anchor) => resolveCliFunction(text, anchor));
}

/**
 * The catalogue.
 *
 * One coherent story: how Claude Code decides whether to summarize an agent's
 * progress, plus the flag, fork-mode and environment plumbing that decision reads.
 * Every description is written from the body the resolver returns — a minified name
 * carries no information, so none of them is inferred from one.
 */
export const CLI_FUNCTION_CATALOGUE: readonly CliFunctionAnchor[] = [
  {
    id: 'agent-summary-prompt',
    label: 'Agent summary prompt',
    description:
      'Builds the "3-5 words, present tense" summary prompt, threading the previous summary in so the next one has to differ.',
    signal: { kind: 'literal', literal: 'Describe your most recent action in 3-5 words' },
  },
  {
    id: 'agent-summary-timer',
    label: 'Agent summary timer',
    description:
      'Re-arms a timer that summarizes an agent: bails under three messages or an unchanged transcript, else forks the context for a one-turn, tool-free query.',
    signal: { kind: 'literal', literal: '[AgentSummary] Timer fired for agent' },
    outward: 1,
  },
  {
    id: 'agent-summaries-enabled-get',
    label: 'Agent summaries enabled — read',
    description: 'Reads the session-wide sdkAgentProgressSummariesEnabled flag off the mutable startup state object.',
    signal: {
      kind: 'literal',
      literal: 'sdkAgentProgressSummariesEnabled',
      near: 'return\\s+[A-Za-z_$][\\w$]*\\.sdkAgentProgressSummariesEnabled',
    },
  },
  {
    id: 'agent-summaries-enabled-set',
    label: 'Agent summaries enabled — write',
    description: 'Writes that same flag from its single argument; this is how the SDK turns progress summaries on.',
    signal: {
      kind: 'literal',
      literal: 'sdkAgentProgressSummariesEnabled',
      near: '\\.sdkAgentProgressSummariesEnabled\\s*=\\s*[A-Za-z_$]',
    },
  },
  {
    id: 'coordinator-mode',
    label: 'Coordinator mode',
    description:
      'True only when CLAUDE_CODE_COORDINATOR_MODE parses truthy, and false again in one non-remote configuration that also demands CLAUDE_CODE_REMOTE.',
    signal: { kind: 'literal', literal: 'CLAUDE_CODE_COORDINATOR_MODE' },
  },
  {
    id: 'non-interactive',
    label: 'Non-interactive session',
    description: 'Negates the startup state’s isInteractive flag — true when nothing interactive is driving the run.',
    signal: { kind: 'literal', literal: 'isInteractive', near: 'return\\s*!\\s*[A-Za-z_$][\\w$]*\\.isInteractive' },
  },
  {
    id: 'fork-subagent-source',
    label: 'Fork-subagent source',
    description:
      'Resolves the fork-subagent mode, but caches and reports it only when it is not "disabled" — so a disabled run re-resolves every time.',
    signal: { kind: 'export', exportName: 'getForkSubagentSource' },
  },
  {
    id: 'fork-subagent-mode',
    label: 'Fork-subagent mode resolver',
    description:
      'Ranks the mode sources: an explicit CLAUDE_CODE_FORK_SUBAGENT wins either way, a non-interactive run is disabled, and a gate decides the rest.',
    signal: {
      kind: 'literal',
      literal: 'CLAUDE_CODE_FORK_SUBAGENT',
      near: 'tr\\(process\\.env\\.CLAUDE_CODE_FORK_SUBAGENT\\)',
    },
  },
  {
    id: 'fork-subagent-enabled',
    label: 'Fork-subagent enabled',
    description: 'The boolean gate over that mode string — anything but "disabled" counts as on.',
    signal: { kind: 'export', exportName: 'isForkSubagentEnabled' },
  },
  {
    id: 'in-fork-child',
    label: 'Fork marker in a transcript',
    description:
      'Reads fork state off the transcript rather than a flag: true when some user message carries the fork marker tag in its text.',
    signal: { kind: 'export', exportName: 'isInForkChild' },
  },
  {
    id: 'env-truthy',
    label: 'Env var truthy parser',
    description:
      'Passes a boolean straight through, otherwise lower-cases and trims the value and accepts 1, true, yes or on.',
    signal: { kind: 'literal', literal: '["1","true","yes","on"]' },
  },
  {
    id: 'env-explicitly-false',
    label: 'Env var explicitly-false parser',
    description:
      'The deliberate mirror: only 0, false, no or off count, so an unset variable is not the same as one turned off.',
    signal: { kind: 'literal', literal: '["0","false","no","off"]' },
  },
];
