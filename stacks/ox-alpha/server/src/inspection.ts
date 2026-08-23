import {
  analyzePrompt,
  buildPromptMix,
  type CaptureEnvelopeV1,
  classifyLiveness,
  type InspectionMessage,
  inspectCaptureRequest,
  inspectCaptureResponse,
  type PromptAnalysis,
  type PromptMixDay,
  type PromptSection,
  promptHash,
  promptSections,
  type SessionLiveness,
  type ToolSchemaSummary,
} from '@agent-proxy/ox-core';

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

/** Flat summaries of every capture, in list order. */
export function collectContextSummaries(envelopes: readonly CaptureEnvelopeV1[]): readonly ContextSummary[] {
  return Object.freeze(envelopes.map(summarize));
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

export function collectToolSchemas(envelopes: readonly CaptureEnvelopeV1[]): readonly ToolSchemaEntry[] {
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

export function collectToolCalls(envelopes: readonly CaptureEnvelopeV1[]): readonly ToolCallEntry[] {
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
          request.instructions !== null && request.instructions.length > 0 ? promptHash(request.instructions) : null;
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
export function collectPromptMix(date: string, envelopes: readonly CaptureEnvelopeV1[]): PromptMixDay {
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
      request.instructions !== null && request.instructions.length > 0 ? promptHash(request.instructions) : null,
    sections: promptSections(request),
  });
}

// A capture's exchange ended when the response carried a terminal Responses
// event (`response.completed`) or a final JSON document marked completed.
export function isTerminalResponseText(responseText: string): boolean {
  if (responseText.includes('"response.completed"')) return true;
  try {
    const parsed: unknown = JSON.parse(responseText);
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).status === 'completed';
  } catch {
    return false;
  }
}

/**
 * Liveness verdicts for each session group, derived from capture activity and
 * terminal-response evidence. Sessions without a datable newest capture read
 * unknown rather than guessing.
 */
export function collectLiveness(
  groups: readonly SessionGroup[],
  envelopes: readonly CaptureEnvelopeV1[],
  now: Date,
): ReadonlyMap<string, SessionLiveness> {
  const byId = new Map(envelopes.map((envelope) => [envelope.recordId, envelope]));
  const verdicts = new Map<string, SessionLiveness>();
  for (const group of groups) {
    const newest = [...group.recordIds]
      .map((recordId) => byId.get(recordId))
      .filter((envelope): envelope is CaptureEnvelopeV1 => envelope !== undefined)
      .filter((envelope) => envelope.capturedAt === group.lastCapturedAt)
      .at(-1);
    verdicts.set(
      group.sessionId,
      classifyLiveness(
        group.lastCapturedAt,
        newest !== undefined ? isTerminalResponseText(newest.responseText) : false,
        now,
      ),
    );
  }
  return verdicts;
}

/** Id-scoped detail: one session's captures summarized. */
export function collectSessionDetail(
  sessionId: string,
  envelopes: readonly CaptureEnvelopeV1[],
): DayInspection['captures'] {
  return Object.freeze(
    envelopes
      .filter((envelope) => {
        const request = inspectCaptureRequest(envelope.requestText);
        return (request.sessionId ?? envelope.recordId) === sessionId;
      })
      .map(summarize),
  );
}

/** Per-session breakdown: counts by model and by report hour. */
export function collectSessionBreakdown(
  sessionId: string,
  envelopes: readonly CaptureEnvelopeV1[],
): Readonly<{
  captures: number;
  models: ReadonlyArray<Readonly<{ model: string; requests: number }>>;
  hours: ReadonlyArray<Readonly<{ hour: string; captures: number }>>;
}> {
  const models = new Map<string, number>();
  const hours = new Map<string, number>();
  let captures = 0;
  for (const envelope of envelopes) {
    const request = inspectCaptureRequest(envelope.requestText);
    if ((request.sessionId ?? envelope.recordId) !== sessionId) continue;
    captures += 1;
    if (request.model !== null) {
      models.set(request.model, (models.get(request.model) ?? 0) + 1);
    }
    const hour = `${envelope.capturedAt.slice(0, 13)}:00`;
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
  }
  return Object.freeze({
    captures,
    models: Object.freeze(
      [...models.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([model, requests]) => Object.freeze({ model, requests })),
    ),
    hours: Object.freeze(
      [...hours.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([hour, count]) => Object.freeze({ hour, captures: count })),
    ),
  });
}
