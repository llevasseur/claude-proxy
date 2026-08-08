import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';

describe('parseCliArgs', () => {
  it('reads flags, lists, switches and positionals', () => {
    const args = parseCliArgs(['judge', '-r', '38', '--confirm', 'a:one', '--confirm', 'b:two', '--json'], {
      aliases: { r: 'range' },
      booleans: ['json'],
      lists: ['confirm'],
    });

    expect(args.positionals).toEqual(['judge']);
    expect(args.flags).toEqual({ range: '38' });
    expect(args.lists).toEqual({ confirm: ['a:one', 'b:two'] });
    expect(args.switches.has('json')).toBe(true);
    expect(args.help).toBe(false);
  });

  it('treats --help as a switch even at the end of argv, where it has no value', () => {
    expect(parseCliArgs(['judge', '--help']).help).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['help']).help).toBe(true);
  });

  it('pins -h to help regardless of what the caller declares', () => {
    // A CLI that wanted `-h` for something else would reintroduce the failure, so
    // the alias is applied after the spec rather than merged into it.
    const args = parseCliArgs(['-h'], { aliases: { h: 'host' } });

    expect(args.help).toBe(true);
    expect(args.flags).toEqual({});
  });

  it('cannot have help configured back into a value-taking flag', () => {
    expect(() => parseCliArgs(['--help'], { booleans: [] })).not.toThrow();
    expect(() => parseCliArgs(['mark', '--help'], { lists: ['help'] })).not.toThrow();
  });

  it('still refuses a value-taking flag with no value', () => {
    expect(() => parseCliArgs(['--range'], { booleans: ['json'] })).toThrow('missing value for --range');
  });

  it('does not mistake a value for a flag', () => {
    const args = parseCliArgs(['add', '--json', '-'], {});

    expect(args.flags).toEqual({ json: '-' });
    expect(args.help).toBe(false);
  });
});
