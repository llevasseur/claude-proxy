import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ProxyLifecycleState = 'startup' | 'ready' | 'upstream-error' | 'shutdown';

export interface ProxyStatus {
  readonly schemaVersion: 1;
  readonly state: ProxyLifecycleState;
  readonly updatedAt: string;
  readonly pid: number;
  readonly listen: Readonly<{ host: string; port: number }>;
  readonly upstreamErrorCount: number;
}

export class ProxyStatusWriter {
  readonly #path: string;
  readonly #host: string;
  readonly #pid: number;
  #port: number;
  #upstreamErrorCount = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, host: string, port: number, pid = process.pid) {
    this.#path = path;
    this.#host = host;
    this.#port = port;
    this.#pid = pid;
  }

  setPort(port: number): void {
    this.#port = port;
  }

  write(state: ProxyLifecycleState): Promise<void> {
    if (state === 'upstream-error') this.#upstreamErrorCount += 1;
    const value: ProxyStatus = Object.freeze({
      schemaVersion: 1,
      state,
      updatedAt: new Date().toISOString(),
      pid: this.#pid,
      listen: Object.freeze({ host: this.#host, port: this.#port }),
      upstreamErrorCount: this.#upstreamErrorCount,
    });
    this.#queue = this.#queue.catch(() => {}).then(() => this.#write(value));
    return this.#queue;
  }

  async #write(value: ProxyStatus): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${this.#pid}.tmp`;
    const handle = await open(temporaryPath, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#path);
  }
}
