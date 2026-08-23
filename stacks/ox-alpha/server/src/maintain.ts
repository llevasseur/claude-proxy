// Headless maintenance: one retention pass over the configured capture
// directory plus a store/source consistency audit, safe to run from cron or
// an operator terminal.
// Usage: pnpm --filter @ox-alpha-proxy/server maintain

import { CaptureStore } from "./capture.ts";
import { readConfig } from "./config.ts";
import { auditConsistency, isConsistent } from "./consistency.ts";
import { UsageDatabase } from "./database.ts";

const config = readConfig();
const retention = config.captureEnabled
  ? await new CaptureStore(
      config.captureDirectory,
      true,
      config.captureRetentionMs,
      config.captureMaxBytes,
    ).maintain()
  : { captureEnabled: false, deletedExpired: 0, deletedOverCap: 0 };

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
