// `--help` tells the caller to parse `--json`'s top-level keys, and doing that crashed
// twice in one session on `SyntaxError: Unexpected token 'S', "Scope: all"…` — pnpm's
// script runner wraps the output in a `$ tsx …` echo and a `Scope: …` banner, on
// whichever stream that pnpm version favours. `--silent` empties both, so the docs name
// it and this drives that exact invocation through pnpm to keep them true.
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

      const payload = JSON.parse(stdout);
      expect(payload).toHaveProperty('meta');
      expect(payload).toHaveProperty(key);

      // stderr has to be empty too — `<cmd> 2>&1 | <parser>` is the shape that broke.
      expect(stderr).toBe('');
    }, 120_000);
  }

  it("emits nothing but the payload on the CLI's own stdout", async () => {
    // No pnpm in the way: one JSON document and nothing else. A stray console.log
    // fails here first.
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
