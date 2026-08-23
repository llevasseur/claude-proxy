// Capture envelope v1: the strict schema for Boat's separately stored,
// redacted request/response body captures. Stored outside the audit directory
// and never merged into sanitized sidecars, whose v1 schema stays untouched
// (ADR 0002). Unknown fields fail validation exactly like the sidecar.
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "recordId",
  "capturedAt",
  "endpoint",
  "requestText",
  "responseText",
] as const;

export const CAPTURE_ENVELOPE_SCHEMA_VERSION = 1 as const;

export interface CaptureEnvelopeV1 {
  readonly schemaVersion: typeof CAPTURE_ENVELOPE_SCHEMA_VERSION;
  readonly recordId: string;
  readonly capturedAt: string;
  readonly endpoint: string;
  readonly requestText: string;
  readonly responseText: string;
}

export class CaptureValidationError extends Error {
  override readonly name = "CaptureValidationError";
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaptureValidationError("capture envelope must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  const allowed: readonly string[] = TOP_LEVEL_KEYS;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length > 0)
    throw new CaptureValidationError(`capture envelope contains unknown field ${unknown[0]}`);
  if (missing.length > 0)
    throw new CaptureValidationError(`capture envelope is missing field ${missing[0]}`);
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new CaptureValidationError(`${path} must be a ${allowEmpty ? "" : "non-empty "}string`);
  }
  return value;
}

export function parseCaptureEnvelope(value: unknown): CaptureEnvelopeV1 {
  const envelope = object(value);
  exactKeys(envelope);
  if (envelope.schemaVersion !== CAPTURE_ENVELOPE_SCHEMA_VERSION) {
    throw new CaptureValidationError("capture envelope schemaVersion is unsupported");
  }
  const capturedAt = string(envelope.capturedAt, "capture.capturedAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(capturedAt) ||
    Number.isNaN(Date.parse(capturedAt))
  ) {
    throw new CaptureValidationError("capture.capturedAt must be an ISO UTC timestamp");
  }
  const endpoint = string(envelope.endpoint, "capture.endpoint");
  if (!endpoint.startsWith("/")) {
    throw new CaptureValidationError("capture.endpoint must start with /");
  }
  return Object.freeze({
    schemaVersion: CAPTURE_ENVELOPE_SCHEMA_VERSION,
    recordId: string(envelope.recordId, "capture.recordId"),
    capturedAt,
    endpoint,
    requestText: string(envelope.requestText, "capture.requestText", true),
    responseText: string(envelope.responseText, "capture.responseText", true),
  });
}
