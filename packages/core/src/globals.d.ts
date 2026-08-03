/**
 * Web-standard globals this package is allowed to reach for.
 *
 * `src` compiles under `types: []` and `lib: ["ES2022"]` so that nothing
 * Node-only can reach the browser bundle `apps/admin` builds from here. That
 * also excludes the few WHATWG globals Node and the browser both provide, so
 * they are declared one at a time instead of by adding the whole `DOM` lib —
 * which would admit `document` and `window`, and `server` has neither.
 *
 * Only in `src`'s own program: `tsconfig.test.json` includes `test` alone, so
 * the test tree keeps Node's own declarations rather than colliding with these.
 */

interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

declare const TextEncoder: {
  prototype: TextEncoder;
  new (): TextEncoder;
};
