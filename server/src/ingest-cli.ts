import { resolveDbPath } from './db/open.js';
import { ingestOnce } from './db/runtime.js';
import { resolveLogDir } from './logs.js';

/**
 * `pnpm --filter server ingest` — rebuild the SQLite view from `logs/`.
 *
 * The server ingests on start and on every log change, so this is for running it
 * explicitly: after pulling a schema change, or as the second half of
 * `rm logs/claude-proxy.db && pnpm --filter server ingest`.
 */
async function main(): Promise<void> {
  const logDir = resolveLogDir();
  const started = Date.now();
  const stats = await ingestOnce(logDir);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[ingest] ${resolveDbPath(logDir)}`);
  console.log(
    `[ingest] ${stats.dirs} director${stats.dirs === 1 ? 'y' : 'ies'} scanned` +
      `, ${stats.dirsSkipped} unchanged` +
      `, ${stats.inserted} request${stats.inserted === 1 ? '' : 's'} added` +
      `, ${stats.deleted} row${stats.deleted === 1 ? '' : 's'} dropped` +
      `, ${stats.skipped} file${stats.skipped === 1 ? '' : 's'} unusable` +
      ` in ${seconds}s`,
  );
  console.log(
    `[ingest] ${stats.sessions} session transcript${stats.sessions === 1 ? '' : 's'}` +
      `, ${stats.sessionsParsed} parsed`,
  );
  console.log(
    `[ingest] ${stats.commandRuns} command run${stats.commandRuns === 1 ? '' : 's'}` +
      `, store ${stats.commandRunsParsed ? 're-read' : 'unchanged'}`,
  );
}

main().catch((err: unknown) => {
  console.error(`[ingest] failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
