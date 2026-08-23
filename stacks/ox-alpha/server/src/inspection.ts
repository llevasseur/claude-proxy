import {
  analyzePrompt,
  buildPromptMix,
  type CaptureEnvelopeV1,
  type InspectionMessage,
  inspectCaptureRequest,
  inspectCaptureResponse,
  type PromptAnalysis,
  type PromptMixDay,
  type PromptSection,
  promptHash,
  promptSections,
  type ToolSchemaSummary,
} from "@ox-alpha-proxy/core";

// Assembly of Boat inspection views from parsed capture envelopes. Pure with
// respect to its inputs; the server layers memoization and pagination on top.

export interface ContextSummary {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly endpoint: string;
  readonly model: string | null;
  readonly messageCount: number;
  readonly instructionsPresent: boolean;
  readonly toolCount: number;
  readonly toolCallCount: number;
  readonly sessionId: string;
}

export interface DayInspection {
  readonly date: string;
  readonly captureCount: number;
  readonly unreadableCaptures: number;
  readonly totalMessages: number;
  readonly totalToolCalls: number;
  readonly captures: readonly ContextSummary[];
}

export interface SessionGroup {
  readonly sessionId: string;
  readonly captureCount: number;
  readonly firstCapturedAt: string;
  readonly lastCapturedAt: string;
  readonly recordIds: readonly string[];
}

export interface ToolSchemaEntry {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly schemaJson: string;
}

export interface ToolCallEntry {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly callId: string | null;
  readonly name: string;
  readonly argumentsText: string;
}

export interface MessageEntry {
  readonly recordId: string;
  readonly role: string | null;
  readonly itemType: string | null;
  readonly text: string;
}

// Captures without any derivable session attribute stay attributable by
// grouping under their own recordId rather than vanishing into one bucket.
function sessionKeyFor(envelope: CaptureEnvelopeV1, derived: string | null): string {
  return derived ?? envelope.recordId;
}

function summarize(envelope: CaptureEnvelopeV1): ContextSummary {
  const request = inspectCaptureRequest(envelope.requestText);
  const response = inspectCaptureResponse(envelope.responseText);
  return Object.freeze({
    recordId: envelope.recordId,
    capturedAt: envelope.capturedAt,
    endpoint: envelope.endpoint,
    model: request.model,
    messageCount: request.messages.length,
    instructionsPresent: request.instructions !== null,
    toolCount: request.tools.length,
    toolCallCount: response.toolCalls.length,
    sessionId: sessionKeyFor(envelope, request.sessionId),
  });
}

export function assembleDay(
  date: string,
  envelopes: readonly CaptureEnvelopeV1[],
  unreadableCaptures: number,
): DayInspection {
  // Filenames embed capturedAt, so list order is chronological already.
  const captures = envelopes.filter((envelope) => envelope.capturedAt.startsWith(date));
  const summaries = captures.map(summarize);
  return Object.freeze({
    date,
    captureCount: summaries.length,
    unreadableCaptures,
    totalMessages: summaries.reduce((total, entry) => total + entry.messageCount, 0),
    totalToolCalls: summaries.reduce((total, entry) => total + entry.toolCallCount, 0),
    captures: Object.freeze(summaries),
  });
}

export function collectSessions(envelopes: readonly CaptureEnvelopeV1[]): readonly SessionGroup[] {
  const groups = new Map<string, { first: string; last: string; recordIds: string[] }>();
  for (const envelope of envelopes) {
    const key = sessionKeyFor(envelope, inspectCaptureRequest(envelope.requestText).sessionId);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        first: envelope.capturedAt,
        last: envelope.capturedAt,
        recordIds: [envelope.recordId],
      });
      continue;
    }
    if (envelope.capturedAt < existing.first) existing.first = envelope.capturedAt;
    if (envelope.capturedAt > existing.last) existing.last = envelope.capturedAt;
    existing.recordIds.push(envelope.recordId);
  }
  return Object.freeze(
    [...groups.entries()]
      .map(([sessionId, group]) =>
        Object.freeze({
          sessionId,
          captureCount: group.recordIds.length,
          firstCapturedAt: group.first,
          lastCapturedAt: group.last,
          recordIds: Object.freeze(group.recordIds),
        }),
      )
      .sort((a, b) => b.lastCapturedAt.localeCompare(a.lastCapturedAt)),
  );
}

export function collectToolSchemas(
  envelopes: readonly CaptureEnvelopeV1[],
): readonly ToolSchemaEntry[] {
  return Object.freeze(
    envelopes.flatMap((envelope) =>
      inspectCaptureRequest(envelope.requestText).tools.map((tool: ToolSchemaSummary) =>
        Object.freeze({
          recordId: envelope.recordId,
          capturedAt: envelope.capturedAt,
          name: tool.name,
          type: tool.type,
          description: tool.description,
          schemaJson: tool.schemaJson,
        }),
      ),
    ),
  );
}

export function collectToolCalls(
  envelopes: readonly CaptureEnvelopeV1[],
): readonly ToolCallEntry[] {
  return Object.freeze(
    envelopes.flatMap((envelope) =>
      inspectCaptureResponse(envelope.responseText).toolCalls.map((call) =>
        Object.freeze({
          recordId: envelope.recordId,
          capturedAt: envelope.capturedAt,
          callId: call.callId,
          name: call.name,
          argumentsText: call.argumentsText,
        }),
      ),
    ),
  );
}

export function collectMessages(envelope: CaptureEnvelopeV1): Readonly<{
  request: readonly MessageEntry[];
  response: readonly MessageEntry[];
  analysis: PromptAnalysis;
}> {
  const request = inspectCaptureRequest(envelope.requestText);
  const response = inspectCaptureResponse(envelope.responseText);
  const asEntries = (messages: readonly InspectionMessage[]): readonly MessageEntry[] =>
    messages.map((message) =>
      Object.freeze({
        recordId: envelope.recordId,
        role: message.role,
        itemType: message.itemType,
        text: message.text,
      }),
    );
  return Object.freeze({
    request: asEntries(request.messages),
    response: asEntries(response.outputMessages),
    analysis: analyzePrompt(request),
  });
}

export interface PromptListingEntry {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly model: string | null;
  /** Instructions hash, or null when the request carried none. */
  readonly instructionsHash: string | null;
  readonly sectionCount: number;
}

/** Per-day prompt listing with stable instruction hashes for drill-down. */
export function collectPromptListings(
  date: string,
  envelopes: readonly CaptureEnvelopeV1[],
): readonly PromptListingEntry[] {
  return Object.freeze(
    envelopes
      .filter((envelope) => envelope.capturedAt.startsWith(date))
      .map((envelope) => {
        const request = inspectCaptureRequest(envelope.requestText);
        const hash =
          request.instructions !== null && request.instructions.length > 0
            ? promptHash(request.instructions)
            : null;
        return Object.freeze({
          recordId: envelope.recordId,
          capturedAt: envelope.capturedAt,
          model: request.model,
          instructionsHash: hash,
          sectionCount: promptSections(request).length,
        });
      }),
  );
}

/** The day's prompt mix over the same inputs the listing uses. */
export function collectPromptMix(
  date: string,
  envelopes: readonly CaptureEnvelopeV1[],
): PromptMixDay {
  return buildPromptMix(
    date,
    envelopes
      .filter((envelope) => envelope.capturedAt.startsWith(date))
      .map((envelope) => {
        const request = inspectCaptureRequest(envelope.requestText);
        return {
          model: request.model,
          instructions: request.instructions,
          promptChars:
            (request.instructions?.length ?? 0) +
            request.messages.reduce((total, message) => total + message.text.length, 0),
        };
      }),
  );
}

export function collectPromptSections(
  envelope: CaptureEnvelopeV1,
): Readonly<{ instructionsHash: string | null; sections: readonly PromptSection[] }> {
  const request = inspectCaptureRequest(envelope.requestText);
  return Object.freeze({
    instructionsHash:
      request.instructions !== null && request.instructions.length > 0
        ? promptHash(request.instructions)
        : null,
    sections: promptSections(request),
  });
}
