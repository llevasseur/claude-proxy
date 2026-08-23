import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSanitizedAuditSidecar } from '../../packages/core/src/index.ts';
import type { ProxyConfig } from '../src/config.ts';
import { type ProxyLogger, startProxy } from '../src/proxy.ts';

interface ClientResult {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const proxyDirectory = dirname(testDirectory);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const silentLogger: ProxyLogger = {
  info() {
    /* silent */
  },
  error() {
    /* silent */
  },
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
  // A proxy still draining status or audit writes can recreate the directory mid-removal.
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-proxy-integration-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function fixtureProxy(upstreamPort: number, directory: string): Promise<{ server: Server; port: number }> {
  const config: ProxyConfig = {
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    auditDirectory: join(directory, 'audit'),
    statusFile: join(directory, 'proxy-status.json'),
  };
  const server = await startProxy(config, silentLogger);
  servers.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

function clientRequest(input: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers?: IncomingHttpHeaders | readonly string[];
  readonly body?: Uint8Array;
  readonly onChunk?: (chunk: Buffer) => void;
}): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: '127.0.0.1',
        port: input.port,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          input.onChunk?.(chunk);
        });
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? '',
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    client.on('error', reject);
    if (input.body) client.write(input.body);
    client.end();
  });
}

async function waitForAudit(directory: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = await readdir(directory).catch(() => []);
    const name = names.find((candidate) => candidate.endsWith('.audit.json'));
    if (name) return join(directory, name);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for audit sidecar');
}

function withoutHost(headers: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === 'host') continue;
    if (headers[index] !== undefined && headers[index + 1] !== undefined) {
      result.push(headers[index]!, headers[index + 1]!);
    }
  }
  return result;
}

test('preserves exchanges while addressing requests to the configured upstream host', async () => {
  const directory = await temporaryDirectory();
  const received: Array<{ method: string; url: string; rawHeaders: readonly string[]; body: Buffer }> = [];
  const upstream = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ method: incoming.method ?? '', url: incoming.url ?? '', rawHeaders: incoming.rawHeaders, body });
      response.sendDate = false;
      response.writeHead(incoming.url?.startsWith('/failure') ? 503 : 207, 'Fixture', [
        'Content-Type',
        'application/octet-stream',
        'X-Fixture',
        'one',
        'Set-Cookie',
        'a=1',
        'Set-Cookie',
        'b=2',
        'Connection',
        'close',
      ]);
      response.end(
        Buffer.concat([Buffer.from(`${incoming.method} ${incoming.url}\n`), body, Buffer.from([0, 255, 1])]),
      );
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);

  for (const fixture of [
    { method: 'GET', path: '/models?after=a%2Fb&limit=2', body: undefined },
    { method: 'POST', path: '/failure?mode=raw', body: Buffer.from([0, 10, 255, 30]) },
  ]) {
    const headers = [
      'Host',
      'fixture.invalid',
      'X-Duplicate',
      'first',
      'X-Duplicate',
      'second',
      'Content-Type',
      'application/octet-stream',
      'Connection',
      'close',
      ...(fixture.body ? ['Content-Length', String(fixture.body.length)] : []),
    ];
    const direct = await clientRequest({ port: upstreamPort, ...fixture, headers });
    const proxied = await clientRequest({ port: proxy.port, ...fixture, headers });
    assert.deepEqual(proxied, direct);
    const directRequest = received.at(-2)!;
    const proxiedRequest = received.at(-1)!;
    assert.equal(proxiedRequest.method, directRequest.method);
    assert.equal(proxiedRequest.url, directRequest.url);
    assert.deepEqual(proxiedRequest.body, directRequest.body);
    assert.deepEqual(withoutHost(proxiedRequest.rawHeaders), withoutHost(directRequest.rawHeaders));
    const hostIndex = proxiedRequest.rawHeaders.findIndex((value) => value.toLowerCase() === 'host');
    assert.deepEqual(proxiedRequest.rawHeaders.slice(hostIndex, hostIndex + 2), ['Host', `127.0.0.1:${upstreamPort}`]);
  }
});

test('keeps absolute-form request targets on the configured upstream', async () => {
  const directory = await temporaryDirectory();
  let receivedUrl = '';
  const upstream = createServer((incoming, response) => {
    receivedUrl = incoming.url ?? '';
    response.end('configured upstream');
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const absoluteTarget = 'http://127.0.0.1:1/future/endpoint?opaque=a%2Fb';
  const result = await clientRequest({ port: proxy.port, method: 'GET', path: absoluteTarget });
  assert.equal(result.body.toString(), 'configured upstream');
  assert.equal(receivedUrl, absoluteTarget);
});

test('forwards the first streaming byte before the upstream response completes', async () => {
  const directory = await temporaryDirectory();
  let releaseUpstream!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const upstream = createServer(async (_incoming, response) => {
    response.sendDate = false;
    response.writeHead(200, { 'content-type': 'application/octet-stream', connection: 'close' });
    response.write(Buffer.from([1, 2, 3]));
    await release;
    response.end(Buffer.from([4, 5, 6]));
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  let completed = false;
  let firstByte!: () => void;
  const firstByteSeen = new Promise<void>((resolve) => {
    firstByte = resolve;
  });
  const resultPromise = clientRequest({
    port: proxy.port,
    method: 'GET',
    path: '/stream',
    onChunk() {
      firstByte();
    },
  }).finally(() => {
    completed = true;
  });

  await firstByteSeen;
  assert.equal(completed, false);
  releaseUpstream();
  const result = await resultPromise;
  assert.deepEqual(result.body, Buffer.from([1, 2, 3, 4, 5, 6]));
});

test('records normalized token and cost data for JSON Responses without retaining seeded secrets', async () => {
  const directory = await temporaryDirectory();
  const secret = 'AUTH_SECRET_98a32';
  const prompt = 'PROMPT_MARKER_b183';
  const output = 'RESPONSE_MARKER_c027';
  const tool = 'TOOL_RESULT_MARKER_d419';
  const upstream = createServer((_incoming, response) => {
    response.sendDate = false;
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'req-safe-1',
      'x-private-response': output,
      connection: 'close',
    });
    response.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: output }] },
          { type: 'function_call_output', output: tool },
        ],
        usage: {
          input_tokens: 1_000_000,
          input_tokens_details: { cached_tokens: 500_000 },
          output_tokens: 100_000,
          output_tokens_details: { reasoning_tokens: 80_000 },
          total_tokens: 1_100_000,
        },
      }),
    );
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const requestBody = Buffer.from(JSON.stringify({ model: 'gpt-5', input: prompt, tools: [{ name: tool }] }));
  const response = await clientRequest({
    port: proxy.port,
    method: 'POST',
    path: '/v1/responses?trace=private-query',
    headers: {
      authorization: `Bearer ${secret}`,
      cookie: `session=${secret}`,
      'content-type': 'application/json',
      'content-length': String(requestBody.length),
    },
    body: requestBody,
  });
  assert.match(response.body.toString(), new RegExp(output));
  const auditDirectory = join(directory, 'audit');
  const auditPath = await waitForAudit(auditDirectory);
  const sidecar = parseSanitizedAuditSidecar(JSON.parse(await readFile(auditPath, 'utf8')));
  assert.equal(sidecar.endpoint, '/v1/responses');
  assert.equal(sidecar.requestId, 'req-safe-1');
  assert.deepEqual(sidecar.usage, {
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    outputTokens: 100_000,
    reasoningOutputTokens: 80_000,
    totalTokens: 1_100_000,
  });
  assert.deepEqual(sidecar.cost, {
    currency: 'USD',
    amountUsd: '1.687500',
    catalogueVersion: '2026-08-22',
  });

  const artifacts = await Promise.all(
    (await readdir(auditDirectory)).map((name) => readFile(join(auditDirectory, name), 'utf8')),
  );
  for (const artifact of artifacts) {
    for (const marker of [secret, prompt, output, tool, 'private-query'])
      assert.equal(artifact.includes(marker), false);
  }
});

test('records the ChatGPT Codex backend responses endpoint', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => {
    response.sendDate = false;
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(
      JSON.stringify({
        id: 'resp_codex_1',
        object: 'response',
        model: 'gpt-5',
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      }),
    );
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5', input: 'private prompt' }));
  await clientRequest({
    port: proxy.port,
    method: 'POST',
    path: '/backend-api/codex/responses',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
  const sidecar = parseSanitizedAuditSidecar(
    JSON.parse(await readFile(await waitForAudit(join(directory, 'audit')), 'utf8')),
  );
  assert.equal(sidecar.endpoint, '/backend-api/codex/responses');
  assert.equal(sidecar.usage.totalTokens, 16);
});

test('records an SSE response that arrives without a content type', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => {
    response.sendDate = false;
    response.writeHead(200, { connection: 'close' });
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n');
    response.end(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          object: 'response',
          model: 'gpt-5',
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5', input: 'private prompt' }));
  await clientRequest({
    port: proxy.port,
    method: 'POST',
    path: '/backend-api/codex/responses',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
  const sidecar = parseSanitizedAuditSidecar(
    JSON.parse(await readFile(await waitForAudit(join(directory, 'audit')), 'utf8')),
  );
  assert.equal(sidecar.endpoint, '/backend-api/codex/responses');
  assert.equal(sidecar.usage.totalTokens, 25);
});

test('records usage when the client hangs up before the upstream stream ends', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => {
    response.sendDate = false;
    response.writeHead(200, {});
    response.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          object: 'response',
          model: 'gpt-5',
          usage: { input_tokens: 30, output_tokens: 2, total_tokens: 32 },
        },
      })}\n\n`,
    );
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5', input: 'private prompt' }));
  const client = request({
    host: '127.0.0.1',
    port: proxy.port,
    method: 'POST',
    path: '/backend-api/codex/responses',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
  });
  client.on('error', () => {
    /* this test destroys the socket deliberately */
  });
  client.on('response', (incoming) => {
    incoming.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('response.completed')) client.destroy();
    });
  });
  client.end(body);
  const sidecar = parseSanitizedAuditSidecar(
    JSON.parse(await readFile(await waitForAudit(join(directory, 'audit')), 'utf8')),
  );
  assert.equal(sidecar.endpoint, '/backend-api/codex/responses');
  assert.equal(sidecar.usage.totalTokens, 32);
});

test('extracts final SSE usage across wire chunks and makes unknown-model cost unavailable', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => {
    response.sendDate = false;
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const events = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"private output"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          object: 'response',
          model: 'future-model',
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    for (const event of events) {
      for (let index = 0; index < event.length; index += 5) response.write(event.slice(index, index + 5));
    }
    response.end();
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const body = Buffer.from(JSON.stringify({ model: 'future-model', input: 'private prompt' }));
  const response = await clientRequest({
    port: proxy.port,
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
  assert.match(response.body.toString(), /response\.completed/);
  const sidecar = parseSanitizedAuditSidecar(
    JSON.parse(await readFile(await waitForAudit(join(directory, 'audit')), 'utf8')),
  );
  assert.deepEqual(sidecar.usage, {
    inputTokens: 7,
    cachedInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 10,
  });
  assert.equal(sidecar.cost, null);
  assert.deepEqual(sidecar.costUnavailableReason, { code: 'unknown-model', model: 'future-model' });
});

test('passes malformed Responses and abrupt upstream disconnects without publishing sidecars', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"object":"response","usage":');
    response.destroy();
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const body = Buffer.from('{malformed request');
  await clientRequest({
    port: proxy.port,
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  }).catch(() => null);
  assert.equal(
    (await readdir(join(directory, 'audit')).catch(() => [])).some((name) => name.endsWith('.audit.json')),
    false,
  );
});

test('propagates a client upload disconnect to the upstream request', async () => {
  const directory = await temporaryDirectory();
  let observeAbort!: () => void;
  const upstreamAborted = new Promise<void>((resolve) => {
    observeAbort = resolve;
  });
  let observeData!: () => void;
  const upstreamReceivedData = new Promise<void>((resolve) => {
    observeData = resolve;
  });
  const upstream = createServer((incoming) => {
    incoming.on('aborted', observeAbort);
    incoming.once('data', observeData);
  });
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  const client = request({
    host: '127.0.0.1',
    port: proxy.port,
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json', 'content-length': '1000000' },
  });
  client.on('error', () => {
    /* this test destroys the socket deliberately */
  });
  client.write('{"model":"gpt-5","input":"partial');
  await upstreamReceivedData;
  client.destroy();
  await Promise.race([
    upstreamAborted,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('upstream request was not aborted')), 1_000),
    ),
  ]);
  assert.equal(
    (await readdir(join(directory, 'audit')).catch(() => [])).some((name) => name.endsWith('.audit.json')),
    false,
  );
});

test('reports an upstream transport failure without exposing its target', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => response.end('ok'));
  const upstreamPort = await listen(upstream);
  const proxy = await fixtureProxy(upstreamPort, directory);
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  const result = await clientRequest({ port: proxy.port, method: 'GET', path: '/unavailable' });
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.toString(), 'Bad Gateway\n');
  const statusFile = join(directory, 'proxy-status.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (JSON.parse(await readFile(statusFile, 'utf8')).state === 'upstream-error') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const statusText = await readFile(statusFile, 'utf8');
  assert.equal(JSON.parse(statusText).state, 'upstream-error');
  assert.equal(statusText.includes(String(upstreamPort)), false);
});

test('runs the CLI directly from TypeScript source and publishes ready then shutdown status', async () => {
  const directory = await temporaryDirectory();
  const upstream = createServer((_incoming, response) => response.end('ok'));
  const upstreamPort = await listen(upstream);
  const statusFile = join(directory, 'cli-status.json');
  const child = spawn(process.execPath, ['src/proxy.ts'], {
    cwd: proxyDirectory,
    env: {
      ...process.env,
      OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: '0',
      AUDIT_DIR: join(directory, 'audit'),
      PROXY_STATUS_FILE: statusFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [output] = (await once(child.stdout, 'data')) as [Buffer];
  const ready = JSON.parse(output.toString().trim()) as { event: string; port: number };
  assert.equal(ready.event, 'proxy-ready');
  assert.ok(ready.port > 0);
  assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).state, 'ready');
  child.kill('SIGTERM');
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  assert.equal(exitCode, 0);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (JSON.parse(await readFile(statusFile, 'utf8')).state === 'shutdown') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).state, 'shutdown');
});

test('package has no runtime dependencies or build output contract', async () => {
  const manifest = JSON.parse(await readFile(join(proxyDirectory, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('dependencies' in manifest, false);
  assert.deepEqual(manifest.bin, { 'codex-proxy': './src/proxy.ts' });
  assert.equal('build' in (manifest.scripts as Record<string, unknown>), false);
  assert.equal((await readdir(proxyDirectory)).includes('dist'), false);
});
