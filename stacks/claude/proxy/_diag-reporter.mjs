/**
 * TEMPORARY DIAGNOSTIC — not part of the suite. Delete once the handle is named.
 *
 * The default reporters hold a test file's output until that file completes, so the
 * file that never completes contributes nothing. A custom reporter runs in the runner
 * process — whose loop is healthy, per /proc — and sees each event as it arrives, so
 * the last `test:start` with no matching `test:pass` names the test that spins.
 */

export default async function* diagReporter(source) {
  for await (const event of source) {
    const name = event.data?.name ?? '';
    const file = event.data?.file ?? '';
    const short = file.slice(file.lastIndexOf('/') + 1);
    if (event.type === 'test:start' || event.type === 'test:pass' || event.type === 'test:fail') {
      yield `[EV] ${event.type} ${short} :: ${name}\n`;
    }
  }
}
