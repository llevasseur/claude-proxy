/* Stamps `data-scrolling` on whichever element is scrolling, and removes it
 * once the gesture has been idle for a beat. `styles/scrollbar.css` keys the
 * thumb's visibility off that attribute — this module is the only writer.
 *
 * One capture-phase document listener covers every scroll container: `scroll`
 * does not bubble, but it does capture, so no component wires its own handler. */

/** Long enough to survive a pause mid-read, short enough that the bar is gone
 * when the eye returns to the content. */
const IDLE_MS = 800;

export function installScrollbarActivity(): void {
  const timers = new WeakMap<Element, number>();

  document.addEventListener(
    'scroll',
    (event) => {
      /* The root scroller reports `document` as the target; the attribute
       * lives on `<html>`, where the CSS can see it. */
      const target = event.target === document ? document.documentElement : event.target;
      if (!(target instanceof Element)) return;

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
    },
    { capture: true, passive: true },
  );
}
