import { readConfig } from "./config.ts";
import { LiveUsageService } from "./service.ts";

const config = readConfig();
const service = new LiveUsageService(config);
const address = await service.start();
console.log(`@agent-proxy/ox-server listening on http://${address.host}:${address.port}`);

function shutdown(): void {
  void service.close().finally(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
