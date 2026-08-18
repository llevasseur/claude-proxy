// `--help` tells the caller to parse `--json`'s top-level keys, so a caller pipes the
// documented invocation into a parser — and that crashed, twice in one session, on
// `SyntaxError: Unexpected token 'S', "Scope: all"…`. pnpm's script runner wraps the
// script's output in a `$ tsx …` echo and a `Scope: … workspace projects` banner, and
// which stream those land on is pnpm's choice rather than the CLI's: current pnpm uses
// stderr, older pnpm used stdout. `--silent` empties both, which is why the docs now
// name it — and this drives that exact invocation through pnpm so they stay true.
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const REPO_ROOT = path.join(HERE, '..', '..');

/** A throwaway log directory: an empty store still answers the documented shape. */
let logDir: string;

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'suggestions-json-'));
});

/** Every `--json` subcommand, paired with the top-level key `--help` promises. */
const SUBCOMMANDS = [
  { args: ['list', '--json'], key: 'rows' },
  { args: ['buckets', '--json'], key: 'buckets' },
  { args: ['defects', '--json'], key: 'defects' },
] as const;

describe('suggestions --json is parseable as emitted', () => {
  for (const { args, key } of SUBCOMMANDS) {
    it(`pnpm --silent --filter server suggestions ${args.join(' ')} parses`, async () => {
      const { stdout, stderr } = await run('pnpm', ['--silent', '--filter', 'server', 'suggestions', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, LOG_DIR: logDir },
        maxBuffer: 64 * 1024 * 1024,
      });

      // The failure this pins is a parse of stdout, so parse it rather than matching it.
      const payload = JSON.parse(stdout) as Record<string, unknown>;
      expect(payload).toHaveProperty('meta');
      expect(payload).toHaveProperty(key);

      // `--silent` has to empty stderr too: `<cmd> 2>&1 | <parser>` is how a caller
      // pipes a command it also wants the errors from, and that shape is what broke.
      expect(stderr).toBe('');
    }, 120_000);
  }

  it("emits nothing but the payload on the CLI's own stdout", async () => {
    // No pnpm in the way, so this pins what is ours to keep true: one JSON document,
    // no progress line, no trailing note. A stray console.log would fail here first.
    const { stdout } = await run('npx', ['tsx', path.join(SRC, 'suggestions-cli.ts'), 'list', '--json'], {
      env: { ...process.env, LOG_DIR: logDir },
      maxBuffer: 64 * 1024 * 1024,
    });

    expect(stdout.trimEnd()).toBe(JSON.stringify(JSON.parse(stdout), null, 2));
  }, 120_000);

  it('still names --silent in the usage text a caller reads first', async () => {
    const { stdout } = await run('npx', ['tsx', path.join(SRC, 'suggestions-cli.ts'), '--help'], {
      env: { ...process.env, LOG_DIR: logDir },
    });

    expect(stdout).toContain('pnpm --silent --filter server suggestions');
  }, 120_000);
});
