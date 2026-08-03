/**
 * The transforms behind a file's "pretty" view in the dashboard: log cleanup, JSON
 * re-indentation, and a small tokenizer for syntax coloring. The "raw" view is the
 * bytes as they are on disk, so everything here is what *pretty* adds.
 *
 * Pure and dependency-free — the admin app maps the tokens onto spans.
 */

/** CSI colour codes, OSC title sequences, and bare two-char escapes. */
const ANSI_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** Strip terminal escape sequences from captured output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Make a captured build log readable: drop terminal escapes, and collapse each
 * line's carriage-return redraws to the frame that was actually left on screen.
 * A progress spinner writes one line hundreds of times separated by `\r`; raw view
 * keeps every frame, pretty view keeps the last one.
 */
export function prettifyLog(text: string): string {
  return stripAnsi(text)
    .split('\n')
    .map((line) => {
      const at = line.lastIndexOf('\r');
      return at === -1 ? line : line.slice(at + 1);
    })
    .join('\n');
}

/**
 * Re-indent JSON at two spaces. `ok: false` (with the input echoed back) when it
 * doesn't parse — a half-written file being appended to as we read it, most often.
 */
export function formatJsonText(text: string): { text: string; ok: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), ok: true };
  } catch {
    return { text, ok: false };
  }
}

/**
 * Comment and string conventions the tokenizer knows — not languages, which is why
 * these are named after the syntax rather than a file type:
 * - `c-like`: `//` and block comments, plus back-tick strings (JS/TS, and close
 *   enough for Go, Rust, Java, C, CSS)
 * - `hash`: `#` line comments (shell, Python, Ruby, YAML, TOML)
 * - `json`: strings, numbers, literals, and keys highlighted apart from values
 * - `plain`: strings and numbers only
 */
export type CodeSyntax = 'c-like' | 'hash' | 'json' | 'plain';

const SYNTAX_BY_EXT: Record<string, CodeSyntax> = {
  js: 'c-like',
  mjs: 'c-like',
  cjs: 'c-like',
  jsx: 'c-like',
  ts: 'c-like',
  tsx: 'c-like',
  mts: 'c-like',
  cts: 'c-like',
  go: 'c-like',
  rs: 'c-like',
  java: 'c-like',
  c: 'c-like',
  h: 'c-like',
  cc: 'c-like',
  cpp: 'c-like',
  css: 'c-like',
  scss: 'c-like',
  sql: 'c-like',
  json: 'json',
  jsonl: 'json',
  ndjson: 'json',
  sh: 'hash',
  bash: 'hash',
  zsh: 'hash',
  fish: 'hash',
  env: 'hash',
  py: 'hash',
  pyi: 'hash',
  rb: 'hash',
  yml: 'hash',
  yaml: 'hash',
  toml: 'hash',
  ini: 'hash',
};

/** Pick a {@link CodeSyntax} from a file name; `plain` when the extension is unknown. */
export function codeSyntax(name: string): CodeSyntax {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return SYNTAX_BY_EXT[ext] ?? 'plain';
}

/** Words each syntax colours as keywords. */
const KEYWORDS: Record<CodeSyntax, ReadonlySet<string>> = {
  'c-like': new Set([
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'of',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'satisfies',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'var',
    'void',
    'while',
    'yield',
  ]),
  hash: new Set([
    'and',
    'as',
    'break',
    'case',
    'class',
    'continue',
    'def',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'export',
    'false',
    'fi',
    'for',
    'from',
    'function',
    'if',
    'import',
    'in',
    'lambda',
    'local',
    'None',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'self',
    'set',
    'source',
    'then',
    'true',
    'True',
    'False',
    'unset',
    'while',
    'with',
  ]),
  json: new Set(['true', 'false', 'null']),
  plain: new Set(),
};

export type CodeTokenKind = 'text' | 'comment' | 'string' | 'number' | 'keyword' | 'key';

/** A coloured run within one line. */
export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

const NUMBER_RE = /0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_$][\w$]*/y;

/** Whether `#` at `i` opens a comment rather than sitting inside a word (`$#`, `a#b`). */
function opensHashComment(source: string, i: number): boolean {
  if (i === 0) return true;
  const prev = source[i - 1] ?? '';
  return /[\s;|&(]/.test(prev);
}

/**
 * Tokenize source into one token run per line. Line count always matches the
 * source's, so the caller can number lines off the result.
 *
 * Deliberately conservative — mis-colouring the rest of a file is worse than
 * leaving something plain, so an unterminated `'`/`"` string ends at its newline
 * (only back-ticks span lines) and anything unrecognised stays `text`.
 */
export function highlightSource(source: string, syntax: CodeSyntax): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  const keywords = KEYWORDS[syntax];

  /** Emit `text` as `kind`, opening a new line at each newline it contains. */
  const push = (kind: CodeTokenKind, text: string): void => {
    const parts = text.split('\n');
    for (let p = 0; p < parts.length; p += 1) {
      if (p > 0) lines.push([]);
      const part = parts[p] ?? '';
      if (part === '') continue;
      const line = lines[lines.length - 1] as CodeToken[];
      const last = line[line.length - 1];
      if (last && last.kind === kind) last.text += part;
      else line.push({ kind, text: part });
    }
  };

  /** Scan a quoted string from its opening quote; returns the index after it. */
  const readString = (start: number, quote: string): number => {
    const spans = quote === '`';
    let i = start + 1;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      if (ch === '\n' && !spans) return i; // unterminated — stop at the line end
      i += 1;
    }
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (syntax === 'c-like' && ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      push('comment', source.slice(i, stop));
      i = stop;
      continue;
    }
    if (syntax === 'c-like' && ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      push('comment', source.slice(i, stop));
      i = stop;
      continue;
    }
    if (syntax === 'hash' && ch === '#' && opensHashComment(source, i)) {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      push('comment', source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || (syntax === 'c-like' && ch === '`')) {
      const stop = readString(i, ch);
      const text = source.slice(i, stop);
      // In JSON a string before a `:` is a key, not a value.
      let after = stop;
      while (after < source.length && /[ \t]/.test(source[after] as string)) after += 1;
      push(syntax === 'json' && source[after] === ':' ? 'key' : 'string', text);
      i = stop;
      continue;
    }
    if (ch >= '0' && ch <= '9' && !/[\w$]/.test(source[i - 1] ?? '')) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(source);
      if (m) {
        push('number', m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(source);
      const word = m?.[0] ?? ch;
      push(keywords.has(word) ? 'keyword' : 'text', word);
      i += word.length;
      continue;
    }
    push('text', ch);
    i += 1;
  }

  return lines;
}
