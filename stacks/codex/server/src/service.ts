import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config.ts';
import { UsageDatabase } from './database.ts';
import { EventHub } from './events.ts';
import { SidecarIngestor } from './ingest.ts';

type ProxyState = 'starting' | 'ready' | 'upstream-error' | 'shutdown';

interface ProxyStatusFile {
  readonly state: ProxyState;
  readonly updatedAt: string;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function validProxyStatus(value: unknown): value is ProxyStatusFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    ['starting', 'ready', 'upstream-error', 'shutdown'].includes(String(status.state)) &&
    typeof status.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(status.updatedAt))
  );
}

export class LiveUsageService {
  private readonly database: UsageDatabase;
  private readonly events = new EventHub();
  private readonly ingestor: SidecarIngestor;
  private ready = false;
  private startedAt: string | null = null;
  private proxy: Readonly<{
    status: 'healthy' | 'degraded' | 'unavailable';
    state: ProxyState | null;
    updatedAt: string | null;
  }> = Object.freeze({ status: 'unavailable', state: null, updatedAt: null });
  private readonly server = createServer(async (request, response) => {
    try {
      await this.route(request, response);
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'internal_error' });
      else response.end();
    }
  });

  constructor(
    private readonly config: ServerConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.database = new UsageDatabase(config.databasePath);
    this.ingestor = new SidecarIngestor(config.auditDirectory, this.database, clock, async () => {
      await this.refresh();
    });
  }

  private async readProxyStatus(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.config.proxyStatusPath, 'utf8'));
      if (!validProxyStatus(parsed)) throw new Error('invalid proxy status');
      this.proxy = Object.freeze({
        status: parsed.state === 'ready' ? 'healthy' : 'degraded',
        state: parsed.state,
        updatedAt: parsed.updatedAt,
      });
    } catch {
      this.proxy = Object.freeze({ status: 'unavailable', state: null, updatedAt: null });
    }
  }

  health(): unknown {
    const diagnostics = this.database.diagnostics();
    return Object.freeze({
      ready: this.ready,
      server: Object.freeze({ status: this.ready ? 'ready' : 'starting', startedAt: this.startedAt }),
      proxy: this.proxy,
      database: Object.freeze({
        status: 'ready',
        path: this.database.path,
        schemaVersion: this.database.schemaVersion,
        journalMode: this.database.journalMode,
        recordCount: diagnostics.recordCount,
      }),
      ingest: Object.freeze({
        lastSuccessfulAt: diagnostics.lastSuccessfulIngest,
        rejectedSidecars: diagnostics.rejectedSidecars,
      }),
      sse: Object.freeze({ subscribers: this.events.subscriberCount }),
    });
  }

  summary(): unknown {
    return this.database.summary(this.clock(), this.config.reportTimezone);
  }

  snapshot(): Readonly<{ health: unknown; summary: unknown }> {
    return Object.freeze({ health: this.health(), summary: this.summary() });
  }

  async refresh(): Promise<boolean> {
    await this.readProxyStatus();
    return this.events.publish(this.snapshot());
  }

  async reconcile(): Promise<void> {
    await this.ingestor.reconcile();
  }

  private async route(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (url.pathname === '/api/health') {
      json(response, 200, this.health());
      return;
    }
    if (url.pathname === '/api/summary') {
      json(response, 200, this.summary());
      return;
    }
    if (url.pathname === '/api/events') {
      this.events.subscribe(response, this.snapshot());
      return;
    }
    json(response, 404, { error: 'not_found' });
  }

  async start(): Promise<Readonly<{ host: string; port: number }>> {
    await this.ingestor.reconcile();
    await this.readProxyStatus();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.ready = true;
    this.startedAt = this.clock().toISOString();
    this.events.startKeepalives(this.config.keepaliveIntervalMs);
    await this.ingestor.start(this.config.reconcileIntervalMs);
    this.events.publish(this.snapshot());
    const address = this.server.address() as AddressInfo;
    return Object.freeze({ host: address.address, port: address.port });
  }

  async close(): Promise<void> {
    this.ready = false;
    this.events.publish(this.snapshot());
    await this.ingestor.close();
    this.events.close();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
    }
    this.database.close();
  }
}
