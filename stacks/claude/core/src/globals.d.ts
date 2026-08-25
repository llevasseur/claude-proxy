/**
 * Web-standard globals `src` may use.
 *
 * `src` compiles under `types: []`, so nothing Node-only reaches the browser
 * bundle `apps/admin` builds from it. Declared one at a time rather than by
 * adding the `DOM` lib, which would admit `document` and `window` that `server`
 * has neither of.
 */

interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

declare const TextEncoder: {
  prototype: TextEncoder;
  new (): TextEncoder;
};
