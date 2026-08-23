import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSanitizedAuditSidecar } from '@agent-proxy/ox-core';
import type { UsageDatabase } from './database.ts';

export interface ReconcileResult {
  readonly changed: boolean;
  readonly accepted: number;
  readonly rejected: number;
}

export function isFinalSidecarFilename(filename: string): boolean {
  return filename.endsWith('.audit.json') && !filename.startsWith('.') && !filename.endsWith('.tmp');
}

// This takes a caught value, which TypeScript types as `unknown` at the catch
// binding itself. Narrowing it is what the body does, so there is no earlier
// boundary at which a named type could have been parsed.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function safeReason(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid JSON';
  if (error instanceof Error) return error.message.slice(0, 240);
  return 'sidecar validation failed';
}

export class SidecarIngestor {
  private watcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private activeReconcile: Promise<ReconcileResult> | null = null;
  private queuedReconcile: Promise<ReconcileResult> | null = null;
  private stopped = false;

  constructor(
    private readonly directory: string,
    private readonly database: UsageDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly onReconciled: (result: ReconcileResult) => void | Promise<void> = () => {
      // No subscriber: reconciling without anyone listening is a valid setup.
    },
  ) {}

  // A scan in flight listed the directory when it started, so handing it to a
  // caller that has written since would answer with a listing older than that
  // write. The watcher starts scans on its own, so an awaited reconcile() had
  // no way to tell a scan that covers its write from one that predates it.
  // Queue a trailing scan instead: callers arriving during a scan share one
  // follow-up, which starts only once the current scan is done.
  async reconcile(): Promise<ReconcileResult> {
    if (this.activeReconcile) {
      this.queuedReconcile ??= this.activeReconcile
        .catch(() => undefined)
        .then(() => {
          this.queuedReconcile = null;
          return this.startReconcile();
        });
      return this.queuedReconcile;
    }
    return this.startReconcile();
  }

  private startReconcile(): Promise<ReconcileResult> {
    this.activeReconcile = this.reconcileFiles().finally(() => {
      this.activeReconcile = null;
    });
    return this.activeReconcile;
  }

  private async reconcileFiles(): Promise<ReconcileResult> {
    await mkdir(this.directory, { recursive: true });
    const entries = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isFinalSidecarFilename(entry.name))
      .map((entry) => entry.name)
      .sort();
    let changed = false;
    let accepted = 0;
    let rejected = 0;
    for (const filename of entries) {
      try {
        const raw = await readFile(join(this.directory, filename), 'utf8');
        const sidecar = parseSanitizedAuditSidecar(JSON.parse(raw));
        if (this.database.ingest(filename, sidecar, this.clock())) changed = true;
        accepted += 1;
      } catch (error) {
        this.database.reject(filename, safeReason(error), this.clock());
        rejected += 1;
      }
    }
    const result = Object.freeze({ changed, accepted, rejected });
    await this.onReconciled(result);
    return result;
  }

  async start(intervalMs: number): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.stopped = false;
    this.watcher = watch(this.directory, (_event, filename) => {
      if (!this.stopped && (filename === null || isFinalSidecarFilename(filename))) {
        void this.reconcile();
      }
    });
    this.interval = setInterval(() => void this.reconcile(), intervalMs);
    this.interval.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.watcher?.close();
    this.watcher = null;
    // The watcher and the interval are both stopped above, so these two are
    // all the work there can be: the scan in flight, and the follow-up it may
    // already have queued. Both are captured before either is awaited, since a
    // queued scan clears the field as it starts, and awaiting the queued chain
    // waits for that trailing scan to finish. Draining both is what keeps a
    // queued scan from reaching the database after it closes.
    const active = this.activeReconcile;
    const queued = this.queuedReconcile;
    await active?.catch(() => undefined);
    await queued?.catch(() => undefined);
  }
}
