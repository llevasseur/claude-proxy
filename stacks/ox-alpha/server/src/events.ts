import type { ServerResponse } from "node:http";

export interface LiveSnapshot {
  readonly health: unknown;
  readonly summary: unknown;
}

function frame(id: number, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private eventId = 0;
  private currentJson: string | null = null;
  private keepalive: NodeJS.Timeout | null = null;

  get subscriberCount(): number {
    return this.clients.size;
  }

  startKeepalives(intervalMs: number): void {
    this.keepalive = setInterval(() => {
      for (const client of this.clients) client.write(": keepalive\n\n");
    }, intervalMs);
    this.keepalive.unref();
  }

  publish(snapshot: LiveSnapshot): boolean {
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.currentJson) return false;
    this.currentJson = serialized;
    const id = ++this.eventId;
    for (const client of this.clients) client.write(frame(id, "update", snapshot));
    return true;
  }

  subscribe(response: ServerResponse, snapshot: LiveSnapshot): () => void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 2000\n");
    this.clients.add(response);
    response.write(frame(++this.eventId, "snapshot", snapshot));
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.clients.delete(response);
    };
    response.once("close", cleanup);
    return cleanup;
  }

  close(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
