import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { writeSanitizedSidecarAtomically } from "./audit.ts";
import { loadProxyConfig, type ProxyConfig } from "./config.ts";
import {
  jsonResponseIdentity,
  makeSidecar,
  responsesRequestModel,
  SseResponseObserver,
} from "./observe.ts";
import { ProxyStatusWriter } from "./proxy-status.ts";

// Wire-forwarding and tap-point mechanics ported from codex-proxy
// `proxy/src/proxy.ts`: raw headers pass through verbatim except Host, the
// response Date header comes from the upstream, streamed bytes pipe straight
// through, and observation is strictly best-effort after the fact.
export interface ProxyLogger {
  readonly info: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  readonly error: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

const consoleLogger: ProxyLogger = {
  info(event, fields = {}) {
    console.log(JSON.stringify({ event, ...fields }));
  },
  error(event, fields = {}) {
    console.error(JSON.stringify({ event, ...fields }));
  },
};

const responsesEndpoints: ReadonlySet<string> = new Set([
  "/v1/responses",
  "/backend-api/codex/responses",
]);

function pathname(requestUrl: string): string {
  return new URL(requestUrl, "http://proxy.local").pathname;
}

function contentType(message: IncomingMessage): string {
  const value = message.headers["content-type"];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function header(message: IncomingMessage, name: string): string | null {
  const value = message.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function upstreamHeaders(clientRequest: IncomingMessage, upstream: URL): string[] {
  const headers: string[] = [];
  for (let index = 0; index < clientRequest.rawHeaders.length; index += 2) {
    const name = clientRequest.rawHeaders[index];
    if (name?.toLowerCase() === "host") continue;
    if (name !== undefined && clientRequest.rawHeaders[index + 1] !== undefined) {
      headers.push(name, clientRequest.rawHeaders[index + 1]!);
    }
  }
  headers.push("Host", upstream.host);
  return headers;
}

function safeError(logger: ProxyLogger, event: string, error: unknown): void {
  logger.error(event, { errorType: error instanceof Error ? error.name : "unknown" });
}

function proxyRequest(
  clientRequest: IncomingMessage,
  clientResponse: ServerResponse,
  config: ProxyConfig,
  status: ProxyStatusWriter,
  logger: ProxyLogger,
): void {
  const requestUrl = clientRequest.url ?? "/";
  const endpoint = pathname(requestUrl);
  const observesResponses =
    clientRequest.method === "POST" &&
    responsesEndpoints.has(endpoint) &&
    contentType(clientRequest).toLowerCase().includes("application/json");
  const requestChunks: Buffer[] = [];
  let requestModel: string | null = null;
  let exchangeComplete = false;
  let published = false;
  let publishObservation: (() => void) | null = null;
  const transport = config.upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamRequest = transport(
    {
      protocol: config.upstream.protocol,
      hostname: config.upstream.hostname,
      port: config.upstream.port,
      method: clientRequest.method,
      path: requestUrl,
      headers: upstreamHeaders(clientRequest, config.upstream),
      setHost: false,
    },
    (upstreamResponse) => {
      void status.write("ready").catch((error) => safeError(logger, "status-write-failed", error));
      const responseChunks: Buffer[] = [];
      const upstreamContentType = contentType(upstreamResponse).toLowerCase();
      const isJson = observesResponses && upstreamContentType.includes("application/json");
      const isSse =
        observesResponses &&
        !isJson &&
        (upstreamContentType.includes("text/event-stream") || upstreamContentType.length === 0);
      const sseObserver = isSse ? new SseResponseObserver() : null;

      upstreamResponse.on("data", (chunk: Buffer) => {
        if (sseObserver) sseObserver.push(chunk);
        if (isJson) responseChunks.push(chunk);
      });
      publishObservation = (): void => {
        if (published || !requestModel) return;
        try {
          const identity =
            sseObserver?.finish() ??
            (isJson ? jsonResponseIdentity(Buffer.concat(responseChunks)) : null);
          if (!identity) return;
          published = true;
          const sidecar = makeSidecar({
            endpoint,
            responseStatus: upstreamResponse.statusCode ?? 502,
            requestId: header(upstreamResponse, "x-request-id"),
            identity,
            recordId: randomUUID(),
            timestamp: new Date().toISOString(),
          });
          void writeSanitizedSidecarAtomically(config.auditDirectory, sidecar)
            .then((file) => logger.info("audit-written", { file }))
            .catch((error) => safeError(logger, "audit-write-failed", error));
        } catch (error) {
          // A parsing or pricing failure must never alter bytes already sent.
          safeError(logger, "observation-failed", error);
        }
      };
      upstreamResponse.on("end", () => {
        exchangeComplete = true;
        const publish = publishObservation;
        if (clientResponse.writableFinished) publish?.();
        else clientResponse.once("finish", () => publish?.());
      });
      upstreamResponse.on("aborted", () => {
        void status
          .write("upstream-error")
          .catch((error) => safeError(logger, "status-write-failed", error));
        clientResponse.destroy();
      });

      clientResponse.sendDate = false;
      if (upstreamResponse.statusMessage) {
        clientResponse.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          upstreamResponse.rawHeaders,
        );
      } else {
        clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.rawHeaders);
      }
      upstreamResponse.pipe(clientResponse);
    },
  );

  upstreamRequest.on("error", (error) => {
    void status
      .write("upstream-error")
      .catch((statusError) => safeError(logger, "status-write-failed", statusError));
    safeError(logger, "upstream-request-failed", error);
    if (clientResponse.headersSent) {
      clientResponse.destroy();
      return;
    }
    const body = "Bad Gateway\n";
    clientResponse.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    clientResponse.end(body);
  });
  clientRequest.on("data", (chunk: Buffer) => {
    if (observesResponses) requestChunks.push(chunk);
  });
  clientRequest.on("end", () => {
    if (observesResponses) requestModel = responsesRequestModel(Buffer.concat(requestChunks));
  });
  clientRequest.on("aborted", () => upstreamRequest.destroy());
  clientResponse.on("close", () => {
    if (exchangeComplete || clientResponse.writableFinished) return;
    publishObservation?.();
    upstreamRequest.destroy();
  });
  clientRequest.pipe(upstreamRequest);
}

export async function startProxy(
  config: ProxyConfig,
  logger: ProxyLogger = consoleLogger,
): Promise<Server> {
  const status = new ProxyStatusWriter(config.statusFile, config.host, config.port);
  await status.write("startup");
  const server = createServer((request, response) =>
    proxyRequest(request, response, config, status, logger),
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  status.setPort(address.port);
  await status.write("ready");
  logger.info("proxy-ready", { host: config.host, port: address.port });
  server.once("close", () => {
    void status.write("shutdown").catch((error) => safeError(logger, "status-write-failed", error));
  });
  return server;
}

async function main(): Promise<void> {
  const server = await startProxy(loadProxyConfig());
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.close((error) => {
      if (error) {
        safeError(consoleLogger, "proxy-shutdown-failed", error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error) => {
    safeError(consoleLogger, "proxy-start-failed", error);
    process.exitCode = 1;
  });
}
