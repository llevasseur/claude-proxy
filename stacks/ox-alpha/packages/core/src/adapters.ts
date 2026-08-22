import type { UsageTotals } from "./types.ts";
import { normalizeResponsesUsage } from "./usage.ts";

// Selection mechanics ported from codex-proxy `proxy/src/observe.ts`: the
// authoritative usage is the one carried by the final `response.completed`
// SSE event (or the whole JSON body for non-streaming responses), fed into
// the single shared normalizer.
export interface ResponseIdentity {
  readonly model: string;
  readonly usage: UsageTotals;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseIdentity(value: unknown): ResponseIdentity | null {
  const response = object(value);
  if (
    response?.object !== "response" ||
    typeof response.model !== "string" ||
    response.model.length === 0
  )
    return null;
  try {
    return Object.freeze({ model: response.model, usage: normalizeResponsesUsage(response.usage) });
  } catch {
    return null;
  }
}

export function jsonResponseIdentity(body: string): ResponseIdentity | null {
  try {
    return responseIdentity(JSON.parse(body));
  } catch {
    return null;
  }
}

export class SseResponseObserver {
  #pending = "";
  #identity: ResponseIdentity | null = null;

  push(chunk: Uint8Array): void {
    this.#pending += new TextDecoder().decode(chunk);
    for (;;) {
      const boundary = this.#pending.search(/\r?\n\r?\n/);
      if (boundary < 0) return;
      const separator = this.#pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      const event = this.#pending.slice(0, boundary);
      this.#pending = this.#pending.slice(boundary + separator.length);
      this.#observeEvent(event);
    }
  }

  finish(): ResponseIdentity | null {
    if (this.#pending.length > 0) this.#observeEvent(this.#pending);
    this.#pending = "";
    return this.#identity;
  }

  #observeEvent(event: string): void {
    let eventName = "";
    const data: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trimStart();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0 || data[0] === "[DONE]") return;
    try {
      const payload = object(JSON.parse(data.join("\n")));
      if (eventName !== "response.completed" && payload?.type !== "response.completed") return;
      const identity = responseIdentity(payload?.response);
      if (identity) this.#identity = identity;
    } catch {
      // Metric observation is intentionally best-effort and cannot gate forwarding.
    }
  }
}
