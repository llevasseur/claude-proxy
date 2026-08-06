import { describe, expect, it } from 'vitest';
import {
  CLI_FUNCTION_CATALOGUE,
  type CliFunctionAnchor,
  extractEnclosingFunction,
  extractFunctionDeclaration,
  resolveCliCatalogue,
  resolveCliFunction,
  resolveExportedName,
  scanBalanced,
} from '../src/cli-internals.js';

/** A literal-signalled anchor with the boilerplate filled in. */
function anchor(literal: string, rest: Partial<CliFunctionAnchor> = {}): CliFunctionAnchor {
  return {
    id: 'probe',
    label: 'Probe',
    description: 'A probe.',
    signal: { kind: 'literal', literal },
    ...rest,
  };
}

describe('scanBalanced', () => {
  it('matches the closing bracket of a plain run', () => {
    const text = 'x({a:[1,2]})y';
    expect(scanBalanced(text, 1)).toBe(text.indexOf(')') + 1);
  });

  it('ignores brackets inside strings, comments and regexes', () => {
    const text = 'f({ a: "}}", b: /[}]/, c: 4 /* } */ })';
    expect(scanBalanced(text, 2)).toBe(text.length - 1);
  });

  it('re-enters template interpolations as code', () => {
    // The `}` closing `${…}` must pop the interpolation rather than close the body.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is bundle source under test — the `${` belongs to the code being scanned, not to this file
    const text = 'g(){return`a${b?`{`:"}"}c`}';
    expect(scanBalanced(text, 3)).toBe(text.length);
  });

  it('returns null when the run never closes', () => {
    expect(scanBalanced('f({a:1', 2)).toBeNull();
  });

  it('returns null when the index is not an opening bracket', () => {
    expect(scanBalanced('abc', 1)).toBeNull();
  });
});

describe('extractEnclosingFunction', () => {
  it('finds the function declaration around an offset', () => {
    const text = 'var q=1;function ylb(e){return"MARK"+e}var z=2;';
    const fn = extractEnclosingFunction(text, text.indexOf('MARK'));
    expect(fn?.name).toBe('ylb');
    expect(fn?.params).toBe('e');
    expect(fn?.source).toBe('function ylb(e){return"MARK"+e}');
  });

  it('takes the innermost function by default and steps out with outward', () => {
    const text = 'function outer(a,b){function inner(){return"MARK"}return inner}';
    expect(extractEnclosingFunction(text, text.indexOf('MARK'))?.name).toBe('inner');
    const host = extractEnclosingFunction(text, text.indexOf('MARK'), 1);
    expect(host?.name).toBe('outer');
    expect(host?.params).toBe('a,b');
  });

  it('names an anonymous arrow from the binding it is assigned to', () => {
    const text = 'let zz=(e,t)=>{return"MARK"};';
    const fn = extractEnclosingFunction(text, text.indexOf('MARK'));
    expect(fn?.name).toBe('zz');
    expect(fn?.params).toBe('e,t');
  });

  it('returns null for an offset no function encloses', () => {
    // The shape a compiled bundle's data section presents: a bare string constant.
    expect(extractEnclosingFunction('const table=["MARK","other"];', 13)).toBeNull();
  });

  it('returns null rather than throwing on an unterminated body', () => {
    expect(extractEnclosingFunction('function f(){"MARK"', 13)).toBeNull();
  });

  it('does not mistake a parenthesised expression for a function', () => {
    expect(extractEnclosingFunction('let v=(1+2);let s="MARK";', 19)).toBeNull();
  });
});

describe('resolveExportedName and extractFunctionDeclaration', () => {
  const text = 'it(M,{isForkSubagentEnabled:()=>GEe,other:()=>zz});function GEe(){return 1}';

  it('reads the minified name out of a bundler export map', () => {
    expect(resolveExportedName(text, 'isForkSubagentEnabled')).toBe('GEe');
  });

  it('returns null for an export the bundle does not have', () => {
    expect(resolveExportedName(text, 'notExported')).toBeNull();
  });

  it('extracts the declaration for a resolved name', () => {
    expect(extractFunctionDeclaration(text, 'GEe')?.source).toBe('function GEe(){return 1}');
  });

  it('skips a name that is referenced but never declared', () => {
    expect(extractFunctionDeclaration(text, 'zz')).toBeNull();
  });
});

describe('resolveCliFunction', () => {
  it('resolves through the literal and reports the minified name', () => {
    const text = 'function abc(e,t){return"MARK"}';
    const entry = resolveCliFunction(text, anchor('MARK'));
    expect(entry.missing).toBeNull();
    expect(entry.name).toBe('abc');
    expect(entry.signature).toBe('abc(e,t)');
    expect(entry.offset).toBe(0);
    expect(entry.length).toBe(text.length);
  });

  it('skips a data-section occurrence and takes the one inside code', () => {
    const strings = 'MARK\0padding\0';
    const text = `${strings}function abc(){return"MARK"}`;
    const entry = resolveCliFunction(text, anchor('MARK'));
    expect(entry.missing).toBeNull();
    expect(entry.offset).toBe(strings.length);
  });

  it('reports signal-missing when the literal is gone', () => {
    const entry = resolveCliFunction('function abc(){return 1}', anchor('MARK'));
    expect(entry).toMatchObject({ missing: 'signal-missing', name: null, offset: null, signature: null });
  });

  it('reports no-enclosing-function when the literal only ever appears in data', () => {
    const entry = resolveCliFunction('const t=["MARK"];', anchor('MARK'));
    expect(entry.missing).toBe('no-enclosing-function');
  });

  it('requires a near match that covers the occurrence, so neighbours stay apart', () => {
    // Getter and setter sit next to each other and share the property name.
    const text = 'function get(){return s.flagX}function set(e){s.flagX=e}';
    const getter = resolveCliFunction(
      text,
      anchor('flagX', { signal: { kind: 'literal', literal: 'flagX', near: 'return\\s+[A-Za-z_$][\\w$]*\\.flagX' } }),
    );
    const setter = resolveCliFunction(
      text,
      anchor('flagX', { signal: { kind: 'literal', literal: 'flagX', near: '\\.flagX\\s*=\\s*[A-Za-z_$]' } }),
    );
    expect(getter.name).toBe('get');
    expect(setter.name).toBe('set');
  });

  it('reports no-match-nearby when the literal is present but never in the required shape', () => {
    const text = 'function get(){return s.flagX}';
    const entry = resolveCliFunction(
      text,
      anchor('flagX', { signal: { kind: 'literal', literal: 'flagX', near: '\\.flagX\\s*=\\s*[A-Za-z_$]' } }),
    );
    expect(entry.missing).toBe('no-match-nearby');
  });

  it('resolves an export signal through the export map', () => {
    const text = 'it(M,{isInForkChild:()=>lvs});function lvs(e){return e.length}';
    const entry = resolveCliFunction(text, {
      ...anchor(''),
      signal: { kind: 'export', exportName: 'isInForkChild' },
    });
    expect(entry.name).toBe('lvs');
    expect(entry.signature).toBe('lvs(e)');
  });

  it('reports signal-missing for an export name this version no longer has', () => {
    const entry = resolveCliFunction('function lvs(e){return e}', {
      ...anchor(''),
      signal: { kind: 'export', exportName: 'isInForkChild' },
    });
    expect(entry.missing).toBe('signal-missing');
  });

  it('reports no-enclosing-function when the export resolves but the declaration does not', () => {
    const entry = resolveCliFunction('it(M,{isInForkChild:()=>lvs});', {
      ...anchor(''),
      signal: { kind: 'export', exportName: 'isInForkChild' },
    });
    expect(entry.missing).toBe('no-enclosing-function');
  });

  it('treats an empty literal as a missing signal rather than matching everywhere', () => {
    expect(resolveCliFunction('function f(){}', anchor('')).missing).toBe('signal-missing');
  });
});

describe('resolveCliCatalogue', () => {
  it('returns one entry per anchor, in catalogue order', () => {
    const entries = resolveCliCatalogue('');
    expect(entries).toHaveLength(CLI_FUNCTION_CATALOGUE.length);
    expect(entries.map((e) => e.id)).toEqual(CLI_FUNCTION_CATALOGUE.map((a) => a.id));
  });

  it('degrades every row on an empty or unrelated bundle instead of throwing', () => {
    for (const text of ['', 'not javascript at all', '\0ÿþ binary noise \0']) {
      expect(resolveCliCatalogue(text).every((e) => e.missing !== null && e.offset === null)).toBe(true);
    }
  });

  it('resolves a row against a synthetic bundle carrying the real signals', () => {
    const text = [
      'function tr(e){let t=String(e);return["1","true","yes","on"].includes(t)}',
      'function ud(e){let t=String(e);return["0","false","no","off"].includes(t)}',
    ].join('');
    const byId = new Map(resolveCliCatalogue(text).map((e) => [e.id, e]));
    expect(byId.get('env-truthy')?.name).toBe('tr');
    expect(byId.get('env-explicitly-false')?.name).toBe('ud');
    expect(byId.get('agent-summary-prompt')?.missing).toBe('signal-missing');
  });

  it('gives every catalogue entry a unique id and a description', () => {
    const ids = CLI_FUNCTION_CATALOGUE.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CLI_FUNCTION_CATALOGUE.every((a) => a.description.length > 0 && a.label.length > 0)).toBe(true);
  });

  it('names no minified identifier in any signal — that is the thing that moves', () => {
    for (const a of CLI_FUNCTION_CATALOGUE) {
      if (a.signal.kind === 'export') expect(a.signal.exportName).toMatch(/[a-z][A-Z]|^[a-z]{6,}$/);
      else expect(a.signal.literal.length).toBeGreaterThan(5);
    }
  });
});
