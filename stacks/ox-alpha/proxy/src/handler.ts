import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const UPSTREAM_DEFAULT = "https://api.openai.com";

function handle(upstream: string, req: IncomingMessage, res: ServerResponse): void {
  void upstream;
  void req;
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "upstream forwarding not yet implemented" }));
}

export function createProxyServer(
  upstream = process.env.OPENAI_UPSTREAM ?? UPSTREAM_DEFAULT,
): Server {
  return createServer((req, res) => handle(upstream, req, res));
}
