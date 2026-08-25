import type { UsageTotals } from './types.ts';
import { normalizeChatCompletionsUsage, normalizeResponsesUsage } from './usage.ts';

// Selection mechanics ported from codex-proxy `proxy/src/observe.ts`: the
// authoritative usage is the one carried by the final `response.completed`
// SSE event (or the whole JSON body for non-streaming responses), fed into
// the single shared normalizer.
export interface ResponseIdentity {
  readonly model: string;
  readonly usage: UsageTotals;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseIdentity(value: unknown): ResponseIdentity | null {
  const response = object(value);
  if (response?.object !== 'response' || typeof response.model !== 'string' || response.model.length === 0) return null;
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

// Chat/completions identity (ADR 0012). A streamed chunk carries the same
// object envelope as a whole response, so both shapes are accepted here.
function chatCompletionIdentity(value: unknown): ResponseIdentity | null {
  const response = object(value);
  if (
    (response?.object !== 'chat.completion' && response?.object !== 'chat.completion.chunk') ||
    typeof response.model !== 'string' ||
    response.model.length === 0
  )
    return null;
  try {
    return Object.freeze({
      model: response.model,
      usage: normalizeChatCompletionsUsage(response.usage),
    });
  } catch {
    return null;
  }
}

export function jsonChatCompletionIdentity(body: string): ResponseIdentity | null {
  try {
    return chatCompletionIdentity(JSON.parse(body));
  } catch {
    return null;
  }
}

// Frames an SSE byte stream into events. Shared so the two observers below
// differ only in which event they consider authoritative.
class SseFramer {
  #pending = '';

  push(chunk: Uint8Array, onEvent: (event: string) => void): void {
    this.#pending += new TextDecoder().decode(chunk);
    for (;;) {
      const boundary = this.#pending.search(/\r?\n\r?\n/);
      if (boundary < 0) return;
      const separator = this.#pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      const event = this.#pending.slice(0, boundary);
      this.#pending = this.#pending.slice(boundary + separator.length);
      onEvent(event);
    }
  }

  finish(onEvent: (event: string) => void): void {
    if (this.#pending.length > 0) onEvent(this.#pending);
    this.#pending = '';
  }
}

function sseEventPayload(event: string): { readonly name: string; readonly data: string } | null {
  let name = '';
  const data: string[] = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trimStart();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0 || data[0] === '[DONE]') return null;
  return { name, data: data.join('\n') };
}

export class SseResponseObserver {
  #framer = new SseFramer();
  #identity: ResponseIdentity | null = null;

  push(chunk: Uint8Array): void {
    this.#framer.push(chunk, (event) => this.#observeEvent(event));
  }

  finish(): ResponseIdentity | null {
    this.#framer.finish((event) => this.#observeEvent(event));
    return this.#identity;
  }

  #observeEvent(event: string): void {
    const parsed = sseEventPayload(event);
    if (!parsed) return;
    try {
      const payload = object(JSON.parse(parsed.data));
      if (parsed.name !== 'response.completed' && payload?.type !== 'response.completed') return;
      const identity = responseIdentity(payload?.response);
      if (identity) this.#identity = identity;
    } catch {
      // Metric observation is intentionally best-effort and cannot gate forwarding.
    }
  }
}

// A chat/completions stream has no terminal named event: usage arrives on a
// late chunk, and only when the client asked for it via stream_options
// (ADR 0012). The last chunk that carries a usage block wins.
export class ChatCompletionSseObserver {
  #framer = new SseFramer();
  #identity: ResponseIdentity | null = null;

  push(chunk: Uint8Array): void {
    this.#framer.push(chunk, (event) => this.#observeEvent(event));
  }

  finish(): ResponseIdentity | null {
    this.#framer.finish((event) => this.#observeEvent(event));
    return this.#identity;
  }

  #observeEvent(event: string): void {
    const parsed = sseEventPayload(event);
    if (!parsed) return;
    try {
      const identity = chatCompletionIdentity(JSON.parse(parsed.data));
      if (identity) this.#identity = identity;
    } catch {
      // Metric observation is intentionally best-effort and cannot gate forwarding.
    }
  }
}
