// Headless maintenance: one retention pass over the configured capture
// directory plus a store/source consistency audit, safe to run from cron or
// an operator terminal.
// Usage: pnpm --filter @ox-alpha-proxy/server maintain

import { CaptureStore } from "./capture.ts";
import { readConfig } from "./config.ts";
import { auditConsistency, isConsistent } from "./consistency.ts";
import { UsageDatabase } from "./database.ts";

const config = readConfig();
// The store idles itself when capture is off, so both modes print the one
// documented shape rather than a second, capture-off-only result.
const retention = await new CaptureStore(
  config.captureDirectory,
  config.captureEnabled,
  config.captureRetentionMs,
  config.captureMaxBytes,
).maintain();

const database = new UsageDatabase(config.databasePath);
try {
  const consistency = await auditConsistency(database, config.auditDirectory);
  console.log(
    JSON.stringify({
      ...retention,
      consistency: { ...consistency, consistent: isConsistent(consistency) },
    }),
  );
} finally {
  database.close();
}
