import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { type CaptureEnvelopeV1, parseCaptureEnvelope } from "../../packages/core/src/index.ts";

// Atomic write mechanics mirror `audit.ts`: same-directory temporary file,
// flush, close, then atomic rename to the immutable final name. Capture files
// live in their own directory (never the audit directory) and carry a
// `.capture.json` suffix the server's sidecar ingest never matches.
export async function writeCaptureEnvelopeAtomically(
  directory: string,
  candidate: CaptureEnvelopeV1,
): Promise<string> {
  const envelope = parseCaptureEnvelope(candidate);
  await mkdir(directory, { recursive: true });
  const stem = `${envelope.capturedAt.replaceAll(":", "-")}_${envelope.recordId}`;
  const finalPath = join(directory, `${stem}.capture.json`);
  const temporaryPath = join(directory, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;

  try {
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporaryPath, finalPath);
    return finalPath;
  } finally {
    if (!closed) await handle.close();
  }
}
