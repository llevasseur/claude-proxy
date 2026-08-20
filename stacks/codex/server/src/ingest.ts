import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { parseSanitizedAuditSidecar } from '@codex-proxy/core';
import type { UsageDatabase } from './database.ts';

export interface ReconcileResult {
  readonly changed: boolean;
  readonly accepted: number;
  readonly rejected: number;
}

export function isFinalSidecarFilename(filename: string): boolean {
  return filename.endsWith('.audit.json') && !filename.startsWith('.') && !filename.endsWith('.tmp');
}

function safeReason(error: unknown): string {
  if (error instanceof SyntaxError) return 'invalid JSON';
  if (error instanceof Error) return error.message.slice(0, 240);
  return 'sidecar validation failed';
}

export class SidecarIngestor {
  private watcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private activeReconcile: Promise<ReconcileResult> | null = null;
  private stopped = false;

  constructor(
    private readonly directory: string,
    private readonly database: UsageDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly onReconciled: (result: ReconcileResult) => void | Promise<void> = () => {},
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    if (this.activeReconcile) return this.activeReconcile;
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
        const raw = await readFile(`${this.directory}/${filename}`, 'utf8');
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
      if (!this.stopped && (filename === null || isFinalSidecarFilename(filename))) void this.reconcile();
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
    await this.activeReconcile;
  }
}
