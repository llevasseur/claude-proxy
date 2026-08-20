import {
  estimateUsageCost,
  normalizeResponsesUsage,
  type SanitizedAuditSidecarV1,
  type UsageTotals,
} from '../../packages/core/src/index.ts';

interface ResponseIdentity {
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

export function responsesRequestModel(body: Uint8Array): string | null {
  try {
    const request = object(JSON.parse(Buffer.from(body).toString('utf8')));
    return typeof request?.model === 'string' && request.model.length > 0 ? request.model : null;
  } catch {
    return null;
  }
}

export function jsonResponseIdentity(body: Uint8Array): ResponseIdentity | null {
  try {
    return responseIdentity(JSON.parse(Buffer.from(body).toString('utf8')));
  } catch {
    return null;
  }
}

export class SseResponseObserver {
  #pending = '';
  #identity: ResponseIdentity | null = null;

  push(chunk: Uint8Array): void {
    this.#pending += Buffer.from(chunk).toString('utf8');
    for (;;) {
      const boundary = this.#pending.search(/\r?\n\r?\n/);
      if (boundary < 0) return;
      const separator = this.#pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      const event = this.#pending.slice(0, boundary);
      this.#pending = this.#pending.slice(boundary + separator.length);
      this.#observeEvent(event);
    }
  }

  finish(): ResponseIdentity | null {
    if (this.#pending.length > 0) this.#observeEvent(this.#pending);
    this.#pending = '';
    return this.#identity;
  }

  #observeEvent(event: string): void {
    let eventName = '';
    const data: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trimStart();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0 || data[0] === '[DONE]') return;
    try {
      const payload = object(JSON.parse(data.join('\n')));
      if (eventName !== 'response.completed' && payload?.type !== 'response.completed') return;
      const identity = responseIdentity(payload?.response);
      if (identity) this.#identity = identity;
    } catch {
      // Metric observation is intentionally best-effort and cannot gate forwarding.
    }
  }
}

export function makeSidecar(input: {
  readonly endpoint: string;
  readonly responseStatus: number;
  readonly requestId: string | null;
  readonly identity: ResponseIdentity;
  readonly recordId: string;
  readonly timestamp: string;
}): SanitizedAuditSidecarV1 {
  const priced = estimateUsageCost(input.identity.model, input.identity.usage);
  return Object.freeze({
    schemaVersion: 1,
    recordId: input.recordId,
    timestamp: input.timestamp,
    model: input.identity.model,
    endpoint: input.endpoint,
    responseStatus: input.responseStatus,
    requestId: input.requestId,
    usage: input.identity.usage,
    cost: priced.cost,
    costUnavailableReason: priced.unavailableReason,
  });
}
