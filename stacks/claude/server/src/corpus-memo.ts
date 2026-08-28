import type { SidecarSource } from './db/source.js';

/**
 * A per-builder slot holding the last payload, keyed on the corpus watermark it
 * was built from.
 *
 * The dashboard's capture ticks land several times a minute — one burst per
 * proxied request — and every tick used to re-run each builder end to end:
 * re-reading the same rows and re-deriving the same digests that the previous
 * tick already produced. Most of that work is thrown away by the byte-identical
 * dedupe in `serveSse`, or answers a poll whose answer has not moved. This memo
 * sits above a builder instead: when the corpus is provably in the state the
 * last build already saw, the last payload is the answer.
 *
 * One slot per label, replaced wholesale whenever the signature moves, so the
 * map cannot grow with history. A `null` payload (a scoped tick's "nothing to
 * send") caches like any other: the same watermark asked the same question gets
 * the same nothing.
 */

interface CorpusSlot {
  /** The watermark and vary string this slot was built from. */
  sig: string;
  payload: unknown;
  /** The build itself, so concurrent callers share one run. */
  inflight: Promise<unknown> | null;
}

const slots = new Map<string, CorpusSlot>();

/** Test-only: drop every held payload, so a test starts cold. */
export function clearCorpusMemo(): void {
  slots.clear();
}

/**
 * Answer `build()` from the slot when `source` vouches the corpus is unchanged;
 * run it once and share the result otherwise. A backing with no
 * {@link SidecarSource.watermark} bypasses the memo entirely, as does one whose
 * watermark cannot be read — a failed probe must never look like an unchanged
 * corpus.
 *
 * `label` separates builders reading different windows over the same corpus,
 * together with `vary` naming everything else the payload depends on — the
 * resolved reporting day, the window length, a model filter, an archive root.
 */
export async function memoiseByCorpus<T>(
  label: string,
  logDir: string,
  source: SidecarSource,
  vary: string,
  build: () => Promise<T>,
): Promise<T> {
  if (!source.watermark) return build();
  const mark = await source.watermark(logDir).catch(() => null);
  if (mark === null) return build();

  const key = `${label}\n${logDir}`;
  const sig = `${mark}|${vary}`;
  const held = slots.get(key);
  if (held && held.sig === sig) {
    if (held.inflight) {
      // SAFETY: a slot is only retrievable under the label whose builder
      // produced it, so its inflight promise resolves with that builder's `T`.
      return held.inflight as Promise<T>;
    }
    // SAFETY: same provenance for the settled payload.
    return held.payload as T;
  }

  const slot: CorpusSlot = { sig, payload: undefined, inflight: null };
  slots.set(key, slot);
  let run: Promise<T>;
  try {
    run = build();
  } catch (err) {
    // A builder that throws before producing a promise must leave no slot
    // behind — a settled slot with no payload would answer `undefined` forever.
    if (slots.get(key) === slot) slots.delete(key);
    throw err;
  }
  slot.inflight = run;
  // Marks the slot settled or sweeps a failed build out of the map. Both
  // outcomes are consumed here, so this chain never rejects on its own — the
  // caller's own `await` above is what surfaces the failure.
  run.then(
    (payload) => {
      slot.payload = payload;
    },
    () => {
      if (slots.get(key) === slot) slots.delete(key);
    },
  );
  return run;
}
