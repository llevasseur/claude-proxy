// Store/source consistency checks (`server/src/db/source.ts` slice at the
// pinned commit): detect drift between the disposable SQLite view and the
// final sidecar directory that is its source of truth (ADR 0002). Read-only —
// this never mutates either side; a drifted store is rebuilt by re-ingest.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSanitizedAuditSidecar } from "@agent-proxy/ox-core";
import type { UsageDatabase } from "./database.ts";
import { isFinalSidecarFilename } from "./ingest.ts";

export interface ConsistencyReport {
  /** Final sidecar filenames present in the audit directory. */
  readonly sidecarFiles: number;
  /** Rows in usage_records and ingest_watermarks. */
  readonly recordRows: number;
  readonly watermarkRows: number;
  /** Sidecar files whose record is absent from usage_records. */
  readonly missingRecords: readonly string[];
  /** Sidecar files with no ingest watermark. */
  readonly missingWatermarks: readonly string[];
  /** Watermarks pointing at a sidecar file that no longer exists. */
  readonly orphanWatermarks: readonly string[];
}

export async function auditConsistency(
  database: UsageDatabase,
  auditDirectory: string,
): Promise<ConsistencyReport> {
  const entries = await readdir(auditDirectory, { withFileTypes: true }).catch(
    () => [] as Array<{ name: string }>,
  );
  const files = entries
    .map((entry) => entry.name)
    .filter(isFinalSidecarFilename)
    .sort();

  const missingRecords: string[] = [];
  const missingWatermarks: string[] = [];
  for (const filename of files) {
    try {
      const raw = await readFile(join(auditDirectory, filename), "utf8");
      const sidecar = parseSanitizedAuditSidecar(JSON.parse(raw));
      if (!database.hasRecord(sidecar.recordId)) missingRecords.push(filename);
      if (!database.hasWatermark(filename)) missingWatermarks.push(filename);
    } catch {
      // Unreadable sidecars belong to ingest's rejection path, not drift.
    }
  }

  const orphans = database
    .allWatermarks()
    .filter((watermark) => !files.includes(watermark.filename))
    .map((watermark) => watermark.filename);

  return Object.freeze({
    sidecarFiles: files.length,
    recordRows: database.diagnostics().recordCount,
    watermarkRows: database.allWatermarks().length,
    missingRecords: Object.freeze(missingRecords),
    missingWatermarks: Object.freeze(missingWatermarks),
    orphanWatermarks: Object.freeze(orphans),
  });
}

/** True when the store matches its source on every checked axis. */
export function isConsistent(report: ConsistencyReport): boolean {
  return (
    report.missingRecords.length === 0 &&
    report.missingWatermarks.length === 0 &&
    report.orphanWatermarks.length === 0 &&
    report.sidecarFiles === report.watermarkRows
  );
}
