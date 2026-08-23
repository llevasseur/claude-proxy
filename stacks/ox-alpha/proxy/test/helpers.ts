import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProxyConfig } from '../src/config.ts';
import { startProxy } from '../src/proxy.ts';

export interface FixtureUpstream {
  readonly server: Server;
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
}

export interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

export function startFixtureUpstream(
  respond: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<FixtureUpstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        rawHeaders: [...req.rawHeaders],
        body,
      });
      respond(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

export async function startProxyOnEphemeralPort(
  upstreamUrl: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<{
  server: Server;
  url: string;
  baseDirectory: string;
  auditDirectory: string;
  captureDirectory: string;
  statusFile: string;
}> {
  const base = await mkdtemp(join(tmpdir(), 'ox-alpha-proxy-test-'));
  const config = loadProxyConfig({
    OPENAI_UPSTREAM: upstreamUrl,
    AUDIT_DIR: join(base, 'audit'),
    PROXY_STATUS_FILE: join(base, 'proxy-status.json'),
    PROXY_PORT: '0',
    PROXY_HOST: '127.0.0.1',
    ...environment,
  });
  const server = await startProxy(config, {
    info: () => {},
    error: () => {},
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    baseDirectory: base,
    auditDirectory: config.auditDirectory,
    captureDirectory: config.captureDirectory,
    statusFile: config.statusFile,
  };
}

export async function waitForFiles(directory: string, count: number, timeoutMs = 3000): Promise<string[]> {
  const { readdirSync } = await import('node:fs');
  return waitFor(
    () => {
      try {
        return readdirSync(directory).filter((name) => name.endsWith('.audit.json'));
      } catch {
        // Directory may not exist yet.
        return [];
      }
    },
    count,
    timeoutMs,
    'files',
  );
}

export async function waitForCaptureFiles(directory: string, count: number, timeoutMs = 3000): Promise<string[]> {
  const { readdirSync } = await import('node:fs');
  return waitFor(
    () => {
      try {
        return readdirSync(directory).filter((name) => name.endsWith('.capture.json'));
      } catch {
        // Directory may not exist yet.
        return [];
      }
    },
    count,
    timeoutMs,
    'capture files',
  );
}

export async function waitFor(
  scan: () => string[],
  count: number,
  timeoutMs: number,
  noun = 'files',
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = scan();
    if (found.length >= count) return found.sort();
    if (Date.now() > deadline) throw new Error(`expected ${count} ${noun}, found ${found.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Remove the scratch tree even when a just-queued status write is still
// settling; retries beat the rmdir/ENOENT race without sleeping arbitrarily.
export async function removeDirectory(directory: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
