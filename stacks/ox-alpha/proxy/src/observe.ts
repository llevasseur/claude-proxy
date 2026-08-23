import {
  ChatCompletionSseObserver,
  jsonChatCompletionIdentity as coreJsonChatCompletionIdentity,
  jsonResponseIdentity as coreJsonResponseIdentity,
  estimateUsageCost,
  type SanitizedAuditSidecarV1,
  SseResponseObserver,
  type UsageTotals,
} from "../../packages/core/src/index.ts";

export { ChatCompletionSseObserver, SseResponseObserver };

// Observation mechanics ported from codex-proxy `proxy/src/observe.ts`: the
// request model comes from the buffered JSON request body, the authoritative
// usage from the final `response.completed` SSE event or the whole JSON
// response body, and pricing runs through the shared core estimator.
interface ResponseIdentity {
  readonly model: string;
  readonly usage: UsageTotals;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRequestModel(body: Uint8Array): string | null {
  try {
    const request = object(JSON.parse(Buffer.from(body).toString("utf8")));
    return typeof request?.model === "string" && request.model.length > 0 ? request.model : null;
  } catch {
    return null;
  }
}

export function jsonResponseIdentity(body: Uint8Array): ResponseIdentity | null {
  return coreJsonResponseIdentity(Buffer.from(body).toString("utf8"));
}

export function jsonChatCompletionIdentity(body: Uint8Array): ResponseIdentity | null {
  return coreJsonChatCompletionIdentity(Buffer.from(body).toString("utf8"));
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
