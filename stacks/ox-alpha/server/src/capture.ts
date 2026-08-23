import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CaptureEnvelopeV1, parseCaptureEnvelope } from "@agent-proxy/ox-core";

// Capture files live in their own directory, separate from sanitized sidecars
// (ADR 0002). The sidecar ingestor only matches `.audit.json`, so capture
// files can never corrupt ingest or the Bike/Car summaries it feeds.
export function isFinalCaptureFilename(filename: string): boolean {
  return (
    filename.endsWith(".capture.json") && !filename.startsWith(".") && !filename.endsWith(".tmp")
  );
}

export interface CaptureMaintenanceResult {
  readonly examined: number;
  readonly deletedExpired: number;
  readonly deletedOverCap: number;
  readonly remainingFiles: number;
  readonly remainingBytes: number;
}

export const IDLE_CAPTURE_MAINTENANCE: Readonly<CaptureMaintenanceResult> = Object.freeze({
  examined: 0,
  deletedExpired: 0,
  deletedOverCap: 0,
  remainingFiles: 0,
  remainingBytes: 0,
});

// Retention maintenance: delete captures older than the retention window,
// then enforce the total size cap oldest-first. Every deletion target was
// already persisted with secrets redacted at write time.
export class CaptureStore {
  constructor(
    private readonly directory: string,
    private readonly enabled: boolean,
    private readonly retentionMs: number,
    private readonly maxBytes: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async maintain(): Promise<CaptureMaintenanceResult> {
    // A server with capture disabled never touches capture files.
    if (!this.enabled) return IDLE_CAPTURE_MAINTENANCE;
    let names: string[] = [];
    try {
      names = (await readdir(this.directory)).filter(isFinalCaptureFilename).sort();
    } catch {
      return { ...IDLE_CAPTURE_MAINTENANCE };
    }
    const now = this.clock().getTime();
    let deletedExpired = 0;
    const survivors: Array<readonly [string, number, number]> = [];
    for (const name of names) {
      const path = join(this.directory, name);
      const info = await stat(path);
      if (now - info.mtimeMs >= this.retentionMs) {
        await rm(path, { force: true });
        deletedExpired += 1;
        continue;
      }
      survivors.push([path, info.mtimeMs, info.size] as const);
    }
    survivors.sort((a, b) => a[1] - b[1]);
    let deletedOverCap = 0;
    let remainingBytes = survivors.reduce((total, [, , size]) => total + size, 0);
    let index = 0;
    while (remainingBytes > this.maxBytes && index < survivors.length) {
      const [path, , size] = survivors[index] ?? [];
      if (path === undefined || size === undefined) break;
      await rm(path, { force: true });
      remainingBytes -= size;
      deletedOverCap += 1;
      index += 1;
    }
    return Object.freeze({
      examined: names.length,
      deletedExpired,
      deletedOverCap,
      remainingFiles: survivors.length - deletedOverCap,
      remainingBytes,
    });
  }

  // Acceptance gate for inspection surfaces (task 10): a capture file parses
  // as strict envelope v1; callers must check the opt-in flag before reading.
  async load(path: string): Promise<CaptureEnvelopeV1> {
    if (!this.enabled) throw new Error("capture is disabled on this server");
    return parseCaptureEnvelope(JSON.parse(await readFile(path, "utf8")));
  }

  private async finalNames(): Promise<string[]> {
    if (!this.enabled) return [];
    try {
      return (await readdir(this.directory)).filter(isFinalCaptureFilename).sort();
    } catch {
      return [];
    }
  }

  // Every valid capture envelope, oldest filename first. Files failing strict
  // validation are skipped (and counted) rather than surfaced to inspection.
  async list(): Promise<Readonly<{ envelopes: readonly CaptureEnvelopeV1[]; unreadable: number }>> {
    const names = await this.finalNames();
    const envelopes: CaptureEnvelopeV1[] = [];
    let unreadable = 0;
    for (const name of names) {
      try {
        envelopes.push(
          parseCaptureEnvelope(JSON.parse(await readFile(join(this.directory, name), "utf8"))),
        );
      } catch {
        unreadable += 1;
      }
    }
    return Object.freeze({ envelopes: Object.freeze(envelopes), unreadable });
  }

  // Cheap change detector for inspection memoization: name/mtime/size of
  // every final capture file. Not a content hash — retention deletions and
  // new writes both move it, which is all the invalidation contract needs.
  async signature(): Promise<string> {
    const names = await this.finalNames();
    if (names.length === 0) return "0";
    const parts: string[] = [];
    for (const name of names) {
      try {
        const info = await stat(join(this.directory, name));
        parts.push(`${name}:${info.mtimeMs}:${info.size}`);
      } catch {
        parts.push(`${name}:gone`);
      }
    }
    return parts.join("|");
  }
}
