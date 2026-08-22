import { createProxyServer } from "./handler.ts";

const host = process.env.PROXY_HOST ?? "127.0.0.1";
const port = Number(process.env.PROXY_PORT ?? 8787);

createProxyServer().listen(port, host, () => {
  console.log(`ox-alpha-proxy listening on http://${host}:${port}`);
});
