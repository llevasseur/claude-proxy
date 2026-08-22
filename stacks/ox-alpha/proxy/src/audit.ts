import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  parseSanitizedAuditSidecar,
  type SanitizedAuditSidecarV1,
} from "../../packages/core/src/index.ts";

// Atomic write mechanics ported from codex-proxy `proxy/src/audit.ts`:
// same-directory temporary file, flush, close, then atomic rename to the
// immutable final name so the server never observes a partial sidecar.
export interface AtomicSidecarHooks {
  readonly beforeRename?: (temporaryPath: string, finalPath: string) => void | Promise<void>;
}

function fileStem(sidecar: SanitizedAuditSidecarV1): string {
  return `${sidecar.timestamp.replaceAll(":", "-")}_${sidecar.recordId}`;
}

export async function writeSanitizedSidecarAtomically(
  directory: string,
  candidate: SanitizedAuditSidecarV1,
  hooks: AtomicSidecarHooks = {},
): Promise<string> {
  const sidecar = parseSanitizedAuditSidecar(candidate);
  await mkdir(directory, { recursive: true });
  const finalPath = join(directory, `${fileStem(sidecar)}.audit.json`);
  const temporaryPath = join(directory, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;

  try {
    await handle.writeFile(`${JSON.stringify(sidecar)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await hooks.beforeRename?.(temporaryPath, finalPath);
    await rename(temporaryPath, finalPath);
    return finalPath;
  } finally {
    if (!closed) await handle.close();
  }
}
