import { readConfig } from './config.ts';
import { LiveUsageService } from './service.ts';

const service = new LiveUsageService(readConfig());
const address = await service.start();
process.stdout.write(`codex-proxy server listening at http://${address.host}:${address.port}\n`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await service.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
