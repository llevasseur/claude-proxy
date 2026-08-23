/**
 * TEMPORARY DIAGNOSTIC — not part of the suite. Delete once the handle is named.
 *
 * The stuck child spins on CPU (/proc says state=R, wchan=0), so its event loop never
 * turns and it can never flush its IPC queue to the runner. That is why the custom
 * reporter saw no events from it — which means "no events" does not prove the spin
 * happens before the tests, only that nothing was ever flushed.
 *
 * `fs.appendFileSync` needs no event loop, so a trace written this way survives a
 * frozen process. Preloaded into every test child via `--import`.
 */

import fs from 'node:fs';
import { afterEach, beforeEach } from 'node:test';

const TRACE = process.env.DIAG_TRACE;
const file = (process.argv[1] ?? '?').split('/').pop();

function note(line) {
  if (!TRACE) return;
  try {
    fs.appendFileSync(TRACE, `${line}\n`);
  } catch {
    // Diagnostic only — a failed trace write must not change what is being measured.
  }
}

note(`LOADED  ${file}`);
beforeEach((t) => note(`START   ${file} :: ${t?.name ?? '?'}`));
afterEach((t) => note(`END     ${file} :: ${t?.name ?? '?'}`));
process.on('exit', () => note(`EXIT    ${file}`));
