export const SERVER_PACKAGE = '@agent-proxy/ox-server';

export interface ServerInfo {
  name: string;
  host: string;
  port: number;
  defaultPort: number;
}

export function serverInfo(env: Readonly<Record<string, string | undefined>> = process.env): ServerInfo {
  return {
    name: SERVER_PACKAGE,
    host: env.SERVER_HOST ?? '127.0.0.1',
    port: Number(env.OX_SERVER_PORT ?? env.SERVER_PORT ?? 8788),
    defaultPort: 8788,
  };
}
