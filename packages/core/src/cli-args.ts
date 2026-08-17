/**
 * The one argv reader behind every `pnpm --filter server <cli>` entry point.
 *
 * The shape is `--flag value` / `-f value`, with anything else a positional. The
 * hazard the shape carries is that an unrecognised `--name` is *assumed* to take
 * the next argv entry, so a flag nobody declared as standalone swallows whatever
 * follows it — and at the end of argv, throws `missing value for --name`.
 *
 * That is correct for a flag that genuinely takes a value and wrong for exactly
 * one word: `--help`. Every agent tries it first, and it is always last on the
 * line, so it always threw and the usage text below it was unreachable. **Help is
 * therefore not a declared boolean here; it is a structural one.** {@link
 * parseCliArgs} folds `help` into the standalone set and pins `-h` to it *after*
 * reading the caller's spec, so no call site can configure the old behaviour back
 * and no new CLI can forget to. The `missing value` error stays exactly as it was
 * for every flag that does take a value.
 */

/** Short letter → long flag name, as `parseCliArgs` resolves one spelling to the other. */
export interface CliAliasMap {
  readonly [short: string]: string;
}

/** The spellings that always mean "print usage", never "consume the next entry". */
export const HELP_SWITCHES: readonly string[] = ['help', 'h'];

export interface CliArgsSpec {
  /** Short letter → long name, e.g. `{ r: 'range' }`. `h` is pinned to `help`. */
  aliases?: CliAliasMap;
  /** Flags that stand alone rather than taking a value. `help` is always one. */
  booleans?: Iterable<string>;
  /** Flags that accumulate, so repeating one escapes a value containing commas. */
  lists?: Iterable<string>;
}

export interface CliArgs {
  positionals: string[];
  flags: Record<string, string>;
  lists: Record<string, string[]>;
  switches: Set<string>;
  /** True for `--help`, `-h`, or a bare `help` positional. Print usage, exit 0. */
  help: boolean;
}

/** Read `--flag value` / `-f value` pairs off argv; anything else is a positional. */
export function parseCliArgs(argv: readonly string[], spec: CliArgsSpec = {}): CliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const switches = new Set<string>();

  // Built last so a caller cannot alias `h` elsewhere or drop `help` from the
  // standalone set — the two moves that would restore the failure this exists for.
  const aliases: CliAliasMap = { ...spec.aliases, h: 'help' };
  const booleans = new Set([...(spec.booleans ?? []), 'help']);
  const listFlags = new Set(spec.lists ?? []);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const match = /^--?([A-Za-z-]+)$/.exec(arg);
    if (!match?.[1]) {
      positionals.push(arg);
      continue;
    }
    const name = aliases[match[1]] ?? match[1];
    if (booleans.has(name)) {
      switches.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${name}`);
    if (listFlags.has(name)) {
      const list = lists[name] ?? [];
      list.push(value);
      lists[name] = list;
    } else flags[name] = value;
  }

  return { positionals, flags, lists, switches, help: switches.has('help') || positionals[0] === 'help' };
}
