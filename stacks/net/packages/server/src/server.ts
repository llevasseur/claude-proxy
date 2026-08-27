// net-server — the internet-spend stack's only process. Hosts the hourly
// collector (decision internet-spend 005) and the CORS'd read API, over one
// SQLite database.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleApiRequest } from './api.ts';
import { collectBatch, startCollector } from './collector.ts';
import { readConfig } from './config.ts';
import { openNetDatabase } from './db.ts';
import type { JsonValue } from './json.ts';

const config = readConfig();
const db = openNetDatabase();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

void collectBatch({ db, now: () => Date.now(), timeZone }).then((result) => {
  if (result.status === 'skipped') {
    process.stdout.write(`net-server first batch skipped: ${result.reason}\n`);
  } else {
    process.stdout.write(
      `net-server first batch stored ${result.storedSamples} row(s), ${result.discontinuities} discontinuity(ies)\n`,
    );
  }
});

const collector = startCollector({ db, now: () => Date.now(), timeZone });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // node parses a repeated Origin header into an array; a request that sends one
  // more than once declares no single origin, so it is treated as declaring none.
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? undefined : rawOrigin;

  let body: JsonValue | undefined;
  if (req.method === 'PUT') {
    try {
      const raw = await readBody(req);
      body = raw.length === 0 ? undefined : JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body must be valid JSON' }));
      return;
    }
  }

  const reply = handleApiRequest({ db, clock: () => Date.now(), timeZone }, req.method ?? 'GET', url, {
    origin,
    body,
    allowedOrigins: config.allowedOrigins,
  });
  const status = reply?.status ?? 404;
  const payload = reply?.body ?? { error: `not found: ${url.pathname}` };
  const headers = reply?.headers ?? {};
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload === null || payload === undefined ? '' : JSON.stringify(payload));
}

const server = createServer((req, res) => {
  void respond(req, res).catch((cause: unknown) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(cause) }));
  });
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`net-server listening at http://${config.host}:${config.port}\n`);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  collector.stop();
  server.close();
  db.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
