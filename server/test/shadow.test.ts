import { afterEach, describe, expect, it } from "vitest";
import { setShadowHooks, shadowCheck, shadowEnabled, type JsonDiff } from "../src/parity.js";

/**
 * Shadow mode is an observer and nothing else: off unless asked for, silent
 * when the two agree, loud when they do not, and incapable of disturbing the
 * response that has already gone out.
 */

/** Let the queued microtask and the promise inside it settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  setShadowHooks({});
  delete process.env.SHADOW_DB;
});

describe("shadowEnabled", () => {
  it("is off unless the flag is set", () => {
    expect(shadowEnabled({})).toBe(false);
    expect(shadowEnabled({ SHADOW_DB: "0" })).toBe(false);
    expect(shadowEnabled({ SHADOW_DB: "1" })).toBe(true);
    expect(shadowEnabled({ SHADOW_DB: "true" })).toBe(true);
  });
});

describe("shadowCheck", () => {
  it("does not even compute the DB answer while disabled", async () => {
    let computed = false;
    shadowCheck("/api/usage", { a: 1 }, async () => {
      computed = true;
      return { a: 2 };
    });
    await settle();
    expect(computed).toBe(false);
  });

  it("stays quiet when the two agree", async () => {
    process.env.SHADOW_DB = "1";
    const seen: string[] = [];
    setShadowHooks({ onMismatch: (label) => seen.push(label), onError: (label) => seen.push(label) });

    shadowCheck("/api/tools", { date: "2026-07-15", topTools: [{ name: "Bash" }] }, async () => ({
      date: "2026-07-15",
      topTools: [{ name: "Bash" }],
    }));
    await settle();
    expect(seen).toEqual([]);
  });

  it("reports where the two differ", async () => {
    process.env.SHADOW_DB = "1";
    const diffs: Array<{ label: string; diff: JsonDiff }> = [];
    setShadowHooks({ onMismatch: (label, diff) => diffs.push({ label, diff }) });

    shadowCheck("/api/summary", { digest: { requestCount: 10 } }, async () => ({ digest: { requestCount: 11 } }));
    await settle();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.label).toBe("/api/summary");
    expect(diffs[0]!.diff).toMatchObject({ path: "digest.requestCount", files: 10, db: 11 });
  });

  it("keeps the two sides labelled correctly once the substrate is the one serving", async () => {
    process.env.SHADOW_DB = "1";
    const diffs: JsonDiff[] = [];
    setShadowHooks({ onMismatch: (_label, diff) => diffs.push(diff) });

    // The served answer is the DB's and the shadow computes the files'. A
    // reported diff still has to name each side for what it is, or it points at
    // the wrong backing.
    shadowCheck(
      "/api/summary",
      { digest: { requestCount: 11 } },
      async () => ({ digest: { requestCount: 10 } }),
      "db",
    );
    await settle();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!).toMatchObject({ path: "digest.requestCount", files: 10, db: 11 });
  });

  it("notices a key that only one side has, rather than comparing loosely", async () => {
    process.env.SHADOW_DB = "1";
    const diffs: JsonDiff[] = [];
    setShadowHooks({ onMismatch: (_label, diff) => diffs.push(diff) });

    shadowCheck("/api/trends", { meta: { days: 7, files: 3 } }, async () => ({ meta: { days: 7 } }));
    await settle();
    expect(diffs).toHaveLength(1);
  });

  it("swallows a substrate that throws, and returns before it runs either way", async () => {
    process.env.SHADOW_DB = "1";
    const errors: string[] = [];
    setShadowHooks({ onError: (label, err) => errors.push(`${label}: ${err.message}`) });

    const served = { ok: true };
    expect(
      shadowCheck("/api/usage", served, async () => {
        throw new Error("database is locked");
      }),
    ).toBeUndefined();
    // The response object is untouched, and nothing rejected.
    expect(served).toEqual({ ok: true });
    await settle();
    expect(errors).toEqual(["/api/usage: database is locked"]);
  });
});
