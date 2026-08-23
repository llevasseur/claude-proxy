import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

// Status-file mechanics ported from codex-proxy `proxy/src/status.ts`: the
// body-free live status signal crosses the process boundary as a file and
// carries no request or response data.
export type ProxyLifecycleState = "startup" | "ready" | "upstream-error" | "shutdown";

// Rolling per-process usage observed on the Responses wire (adaptation of the
// pinned `proxy/usage-live.ts` outcome — live usage published beside the
// status signal). Sanitized token counts only, never bodies.
export interface ProxyRollingUsage {
  readonly windowStartedAt: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface ProxyStatus {
  readonly schemaVersion: 1;
  readonly state: ProxyLifecycleState;
  readonly updatedAt: string;
  readonly pid: number;
  readonly listen: Readonly<{ host: string; port: number }>;
  readonly upstreamErrorCount: number;
  readonly rollingUsage: ProxyRollingUsage | null;
}

export class ProxyStatusWriter {
  readonly #path: string;
  readonly #host: string;
  readonly #pid: number;
  #port: number;
  #upstreamErrorCount = 0;
  #state: ProxyLifecycleState = "startup";
  #rolling: ProxyRollingUsage | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, host: string, port: number, pid = process.pid) {
    this.#path = path;
    this.#host = host;
    this.#pid = pid;
    this.#port = port;
  }

  setPort(port: number): void {
    this.#port = port;
  }

  // Accumulate one observed exchange into the rolling window and republish the
  // current state. Best-effort by construction: callers already swallow errors.
  noteUsage(
    usage: Readonly<{
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    }>,
  ): Promise<void> {
    const now = new Date().toISOString();
    if (this.#rolling === null) {
      this.#rolling = {
        windowStartedAt: now,
        requests: 1,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens,
      };
    } else {
      this.#rolling = {
        windowStartedAt: this.#rolling.windowStartedAt,
        requests: this.#rolling.requests + 1,
        inputTokens: this.#rolling.inputTokens + usage.inputTokens,
        cachedInputTokens: this.#rolling.cachedInputTokens + usage.cachedInputTokens,
        outputTokens: this.#rolling.outputTokens + usage.outputTokens,
        reasoningOutputTokens: this.#rolling.reasoningOutputTokens + usage.reasoningOutputTokens,
        totalTokens: this.#rolling.totalTokens + usage.totalTokens,
      };
    }
    return this.write(this.#state);
  }

  write(state: ProxyLifecycleState): Promise<void> {
    if (state === "upstream-error") this.#upstreamErrorCount += 1;
    this.#state = state;
    const value: ProxyStatus = Object.freeze({
      schemaVersion: 1,
      state,
      updatedAt: new Date().toISOString(),
      pid: this.#pid,
      listen: Object.freeze({ host: this.#host, port: this.#port }),
      upstreamErrorCount: this.#upstreamErrorCount,
      rollingUsage: this.#rolling === null ? null : Object.freeze({ ...this.#rolling }),
    });
    this.#queue = this.#queue.catch(() => {}).then(() => this.#write(value));
    return this.#queue;
  }

  async #write(value: ProxyStatus): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${this.#pid}.tmp`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#path);
  }
}
