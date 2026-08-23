// Headless capture maintenance: one retention pass over the configured
// capture directory, safe to run from cron or an operator terminal.
// Usage: pnpm --filter @ox-alpha-proxy/server maintain
import { CaptureStore } from "./capture.ts";
import { readConfig } from "./config.ts";

const config = readConfig();
if (!config.captureEnabled) {
  console.log(JSON.stringify({ captureEnabled: false, deletedExpired: 0, deletedOverCap: 0 }));
} else {
  const store = new CaptureStore(
    config.captureDirectory,
    true,
    config.captureRetentionMs,
    config.captureMaxBytes,
  );
  const result = await store.maintain();
  console.log(JSON.stringify({ captureEnabled: true, ...result }));
}
