/* Stamps `data-scrolling` on whichever element is scrolling, and removes it
 * once the gesture has been idle for a beat. `styles/scrollbar.css` keys the
 * thumb's scrolling colour off that attribute — this module is the only writer.
 *
 * One capture-phase document listener covers every scroll container: `scroll`
 * does not bubble, but it does capture, so no component wires its own handler. */

/** Long enough to survive a pause mid-read, short enough that the bar is back to
 * rest when the eye returns to the content. */
const IDLE_MS = 800;

export function installScrollbarActivity(): void {
  const timers = new WeakMap<Element, number>();

  function stamp(target: Element): void {
    target.setAttribute('data-scrolling', '');
    const pending = timers.get(target);
    if (pending !== undefined) window.clearTimeout(pending);
    timers.set(
      target,
      window.setTimeout(() => {
        target.removeAttribute('data-scrolling');
        timers.delete(target);
      }, IDLE_MS),
    );
  }

  document.addEventListener(
    'scroll',
    (event) => {
      /* The root scroller reports `document` as the target, and it takes both
       * elements rather than either one. Chrome resolves the viewport
       * scrollbar's `::-webkit-scrollbar-*` styles from `<body>`, so stamping
       * `<html>` alone leaves the page's own thumb at its resting colour while
       * every other scroller brightens; Firefox's `scrollbar-color` propagates
       * from `<html>`, so dropping that one trades one browser for the other.
       * Measured, not assumed — see the round 2 shots on the branch that added
       * this. */
      if (event.target === document) {
        stamp(document.documentElement);
        stamp(document.body);
        return;
      }
      if (!(event.target instanceof Element)) return;
      stamp(event.target);
    },
    { capture: true, passive: true },
  );
}
