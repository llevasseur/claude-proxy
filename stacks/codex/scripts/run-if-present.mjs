import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [marker, command, ...args] = process.argv.slice(2);

if (!marker || !command) {
  console.error('usage: run-if-present <marker> <command> [...args]');
  process.exit(2);
}

if (!existsSync(marker)) {
  process.exit(0);
}

const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
