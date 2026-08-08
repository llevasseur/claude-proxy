// `suggestions judge --help` used to exit 1 with `missing value for --help`, because
// the parser assumed any undeclared `--name` took the next argv entry — so the usage
// text was unreachable by the one flag every caller tries first. The fix is
// structural (`parseCliArgs` pins help as a switch), and this drives the real
// entry points over a process boundary so it stays that way for every subcommand.
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

/** Every subcommand each CLI dispatches, plus the bare invocation. */
const ENTRIES = [
  { cli: 'suggestions', file: 'suggestions-cli.ts', commands: ['', 'list', 'mark', 'buckets', 'judge', 'defects'] },
  { cli: 'ideas', file: 'ideas-cli.ts', commands: ['', 'list', 'add', 'mark'] },
] as const;

/** A throwaway log directory, so a help run can never read or write the real one. */
let logDir: string;

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'cli-help-'));
});

async function invoke(file: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run('npx', ['tsx', path.join(SRC, file), ...args], {
      env: { ...process.env, LOG_DIR: logDir },
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('CLI help', () => {
  for (const { cli, file, commands } of ENTRIES) {
    for (const command of commands) {
      for (const flag of ['--help', '-h']) {
        const label = [cli, command, flag].filter(Boolean).join(' ');
        it(`${label} prints usage and exits 0`, async () => {
          const { code, stdout } = await invoke(file, [...(command ? [command] : []), flag]);

          expect(code).toBe(0);
          expect(stdout).toContain('usage:');
          expect(stdout).toContain(`${cli} list`);
        }, 60_000);
      }
    }
  }

  it('still refuses a flag that genuinely takes a value and was given none', async () => {
    const { code, stdout } = await invoke('suggestions-cli.ts', ['list', '--range']);

    expect(code).toBe(1);
    expect(stdout).toContain('missing value for --range');
  });
});
