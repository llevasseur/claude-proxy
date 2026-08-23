/**
 * TEMPORARY DIAGNOSTIC — not part of the suite. Delete once the handle is named.
 *
 * `node --test` buffers a test file's output until that file completes, so a child
 * that never exits prints nothing at all: the CI log for the hang shows three files
 * reporting and two silent. This names what is holding the loop instead.
 *
 * The timer is `unref`'d on purpose. An unref'd timer cannot by itself keep the
 * process alive, so on a healthy run it never fires and costs nothing — verified
 * locally at 91 pass, exit 0, with no output from this file. It fires only when
 * something *else* is holding the event loop open, which is the state being
 * diagnosed. Loaded into every test child via `--import` in the package's `test`
 * script.
 */

const WATCHDOG_MS = 45_000;

const timer = setTimeout(() => {
  const file = process.argv[1] ?? '<unknown>';
  console.error(`[DIAG] ${file} still alive after ${WATCHDOG_MS}ms`);
  console.error(`[DIAG] getActiveResourcesInfo: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  // Diagnostic scaffolding: ending the child is what flushes its buffered report into
  // the CI log. This whole file goes away with the fix.
  process.exit(97);
}, WATCHDOG_MS);

timer.unref();
