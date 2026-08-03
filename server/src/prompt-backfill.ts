/**
 * Give historical sidecars the system-prompt identity the proxy now captures.
 *
 * The hash and outline are re-derived from the `.request.txt` body beside each
 * sidecar, so this reaches back only as far as retention has kept bodies.
 * Older sidecars keep the model+size-band cohort they always had.
 *
 * Strictly additive: a sidecar already carrying `request.system` is left
 * untouched, and no field is ever removed or rewritten.
 */
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAuditSidecar, outlineWirePrompt, type AuditSidecar } from "@claude-proxy/core";
import { hashWirePrompt, readStoredPrompt, writeStoredPrompt } from "./prompt-store.js";

const AUDIT_SUFFIX = ".audit.json";
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One sidecar to consider, with the directory its body would share. */
export interface BackfillTarget {
  dir: string;
  /** Sidecar base name, e.g. `2026-08-02T13-31-00-278_anthropic`. */
  base: string;
  /** Archived day, or null for the live directory. */
  day: string | null;
}

/** What a run did, or would do. Every sidecar lands in exactly one bucket. */
export interface BackfillReport {
  scanned: number;
  /** Already carried `request.system` — the steady state once this has run. */
  alreadyTagged: number;
  /** Body evicted or never written; nothing to re-derive from. */
  bodyMissing: number;
  /** Body present but not parseable as JSON, or sidecar malformed. */
  unparseable: number;
  /** Request genuinely carried no system prompt. */
  noSystem: number;
  /** Sidecars tagged (or that would be). */
  tagged: number;
  /** Distinct prompts written to the store. */
  promptsStored: number;
  /** Distinct hashes seen across the run. */
  distinctPrompts: number;
  /** Per-file failures, as `<base>: <message>`. Never fatal. */
  errors: string[];
}

function emptyReport(): BackfillReport {
  return {
    scanned: 0,
    alreadyTagged: 0,
    bodyMissing: 0,
    unparseable: 0,
    noSystem: 0,
    tagged: 0,
    promptsStored: 0,
    distinctPrompts: 0,
    errors: [],
  };
}

/** Every sidecar in the live directory and each archived day, oldest first. */
export async function collectBackfillTargets(logDir: string): Promise<BackfillTarget[]> {
  const root = path.resolve(logDir);
  const targets: BackfillTarget[] = [];

  const bases = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((n) => n.endsWith(AUDIT_SUFFIX)).map((n) => n.slice(0, -AUDIT_SUFFIX.length)).sort();
    } catch {
      return [];
    }
  };

  let days: string[];
  try {
    days = (await readdir(path.join(root, "archive"))).filter((d) => DAY_DIR_RE.test(d)).sort();
  } catch {
    days = [];
  }
  for (const day of days) {
    const dir = path.join(root, "archive", day);
    for (const base of await bases(dir)) targets.push({ dir, base, day });
  }
  for (const base of await bases(root)) targets.push({ dir: root, base, day: null });

  return targets;
}

/** Write a patched sidecar through a temp file, so a crash cannot truncate it. */
async function writeSidecarAtomic(file: string, sidecar: AuditSidecar): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(sidecar, null, 2)}`, "utf8");
  await rename(temp, file);
}

/**
 * Re-derive prompt identity for every sidecar that lacks it. `apply` false
 * inspects and reports without writing anything, which is what the CLI does by
 * default.
 */
export async function backfillPromptIdentity(
  logDir: string,
  options: { apply?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<BackfillReport> {
  const { apply = false, onProgress } = options;
  const report = emptyReport();
  const targets = await collectBackfillTargets(logDir);
  const seenHashes = new Set<string>();
  // Hashes stored this run, so a dry run's count matches what --apply would write.
  const storedThisRun = new Set<string>();

  for (const [index, target] of targets.entries()) {
    report.scanned += 1;
    onProgress?.(index + 1, targets.length);

    const sidecarPath = path.join(target.dir, `${target.base}${AUDIT_SUFFIX}`);
    try {
      const parsed: unknown = JSON.parse(await readFile(sidecarPath, "utf8"));
      if (!isAuditSidecar(parsed)) {
        report.unparseable += 1;
        continue;
      }
      if (parsed.request.system) {
        report.alreadyTagged += 1;
        seenHashes.add(parsed.request.system.hash);
        continue;
      }

      let body: unknown;
      try {
        body = JSON.parse(await readFile(path.join(target.dir, `${target.base}.request.txt`), "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") report.bodyMissing += 1;
        else report.unparseable += 1;
        continue;
      }

      const system = (body as { system?: unknown } | null)?.system;
      if (system === undefined || system === null) {
        report.noSystem += 1;
        continue;
      }

      const outline = outlineWirePrompt(system);
      const hash = hashWirePrompt(system);
      seenHashes.add(hash);

      if (apply) {
        if (await writeStoredPrompt(logDir, hash, outline, parsed.timestamp)) report.promptsStored += 1;
        parsed.request.system = { hash, blocks: outline.blocks.length, sections: outline.sections.length };
        await writeSidecarAtomic(sidecarPath, parsed);
      } else if (!storedThisRun.has(hash)) {
        storedThisRun.add(hash);
        if (!(await readStoredPrompt(logDir, hash))) report.promptsStored += 1;
      }
      report.tagged += 1;
    } catch (err) {
      report.errors.push(`${target.base}: ${(err as Error).message}`);
    }
  }

  report.distinctPrompts = seenHashes.size;
  return report;
}
