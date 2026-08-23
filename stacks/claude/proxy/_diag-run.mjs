/**
 * TEMPORARY DIAGNOSTIC — not part of the suite. Delete once the handle is named.
 *
 * The stuck test children do not turn their event loop: an unref'd watchdog loaded
 * into every child via `--import` never fired at 45s, and `--import` was confirmed to
 * reach all five children. So no in-process JS probe can report from them, and the
 * observer has to sit outside.
 *
 * This wraps `node --test` in a parent whose own loop is healthy. If the run has not
 * finished in time, it walks /proc for the surviving descendants and prints, per pid,
 * the kernel's own account of what they are blocked in — `wchan` names the kernel
 * function, `syscall` names the syscall and its arguments, and `fd/1` and `fd/2` say
 * what stdout and stderr are actually connected to.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DEADLINE_MS = 90_000;
const args = process.argv.slice(2);

const TRACE = `${process.cwd()}/_diag-trace.txt`;
fs.rmSync(TRACE, { force: true });

const child = spawn(process.execPath, ['--test', '--import', './_diag-trace.mjs', ...args], {
  stdio: 'inherit',
  env: { ...process.env, DIAG_TRACE: TRACE },
});

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (cause) {
    return `<unreadable: ${cause.code ?? 'error'}>`;
  }
};

const linkOf = (p) => {
  try {
    return fs.readlinkSync(p);
  } catch (cause) {
    return `<unreadable: ${cause.code ?? 'error'}>`;
  }
};

/** Every live pid, with its parent, read from /proc/<pid>/stat. */
function processTable() {
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const stat = read(`/proc/${name}/stat`);
    // `comm` is parenthesised and may contain spaces, so split after the last ')'.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (tail.length < 2) continue;
    rows.push({ pid: Number(name), ppid: Number(tail[1]), state: tail[0] });
  }
  return rows;
}

function descendants(rootPid) {
  const rows = processTable();
  const found = [rootPid];
  for (let i = 0; i < found.length; i += 1) {
    for (const row of rows) {
      if (row.ppid === found[i] && !found.includes(row.pid)) found.push(row.pid);
    }
  }
  return found.map((pid) => ({ pid, state: rows.find((r) => r.pid === pid)?.state ?? '?' }));
}

const timer = setTimeout(() => {
  console.log(`[DIAG] run has not finished after ${DEADLINE_MS}ms — inspecting /proc`);
  for (const { pid, state } of descendants(child.pid)) {
    console.log(`[DIAG] --- pid ${pid} state=${state}`);
    console.log(`[DIAG]   cmdline: ${read(`/proc/${pid}/cmdline`).split('\0').join(' ')}`);
    console.log(`[DIAG]   wchan:   ${read(`/proc/${pid}/wchan`)}`);
    console.log(`[DIAG]   syscall: ${read(`/proc/${pid}/syscall`)}`);
    console.log(`[DIAG]   stack:   ${read(`/proc/${pid}/stack`).split('\n').join(' | ')}`);
    console.log(`[DIAG]   fd/0:    ${linkOf(`/proc/${pid}/fd/0`)}`);
    console.log(`[DIAG]   fd/1:    ${linkOf(`/proc/${pid}/fd/1`)}`);
    console.log(`[DIAG]   fd/2:    ${linkOf(`/proc/${pid}/fd/2`)}`);
  }
  console.log('[DIAG] --- synchronous trace (survives a frozen loop) ---');
  for (const line of read(TRACE).split('\n')) console.log(`[DIAG]   ${line}`);
  console.log('[DIAG] inspection done — killing the run');
  child.kill('SIGKILL');
  process.exitCode = 98;
}, DEADLINE_MS);

child.on('exit', (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 0;
});
