// Boat inspection domain: tolerant, deterministic analysis of captured
// request and response body text (OpenAI Responses shapes). Every function
// degrades to a typed empty result when the text is absent or unparseable;
// none of them throw on malformed bodies. Pure: no Node imports, no I/O.

export interface InspectionMessage {
  readonly role: string | null;
  readonly itemType: string | null;
  readonly text: string;
}

export interface ToolSchemaSummary {
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly schemaJson: string;
}

export interface CaptureRequestInspection {
  readonly parsed: boolean;
  readonly model: string | null;
  readonly instructions: string | null;
  readonly sessionId: string | null;
  readonly messages: readonly InspectionMessage[];
  readonly tools: readonly ToolSchemaSummary[];
}

export interface InspectionToolCall {
  readonly callId: string | null;
  readonly name: string;
  readonly argumentsText: string;
}

export interface CaptureResponseInspection {
  readonly parsed: boolean;
  readonly outputMessages: readonly InspectionMessage[];
  readonly toolCalls: readonly InspectionToolCall[];
}

export interface PromptAnalysis {
  readonly parsed: boolean;
  readonly model: string | null;
  readonly instructionsPresent: boolean;
  readonly instructionsChars: number;
  readonly inputMessageCount: number;
  readonly inputChars: number;
  readonly toolCount: number;
  // Rough planning heuristic (~4 chars per token), not a usage measurement:
  // token totals stay authoritative in the sanitized sidecar.
  readonly estimatedInputTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Content parts carry their text under `text` regardless of part type; a bare
// string content field is the whole text.
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (isRecord(content)) return contentText(content.text);
    return '';
  }
  const parts = content.map((part) => (isRecord(part) ? contentText(part.text) : ''));
  return parts.filter((text) => text.length > 0).join('\n');
}

function itemToMessage(item: unknown): InspectionMessage | null {
  if (typeof item === 'string') return { role: 'user', itemType: null, text: item };
  if (!isRecord(item)) return null;
  const text = item.content !== undefined ? contentText(item.content) : contentText(item.text);
  return Object.freeze({
    role: optionalString(item.role),
    itemType: optionalString(item.type),
    text,
  });
}

function collectInputItems(body: Record<string, unknown>): unknown[] {
  const input = body.input;
  if (typeof input === 'string') return [input];
  return Array.isArray(input) ? input : [];
}

// Session identity comes from explicit request attributes only; the envelope
// v1 schema carries no session field. Preference order: session_id,
// metadata.session_id, user. Callers fall back to the recordId so every
// capture stays attributable even without any identifier.
export function deriveSessionId(body: Record<string, unknown>): string | null {
  const direct = optionalString(body.session_id);
  if (direct) return direct;
  if (isRecord(body.metadata)) {
    const nested = optionalString(body.metadata.session_id);
    if (nested) return nested;
  }
  return optionalString(body.user);
}

// The Responses API defines function tools flatly (name/parameters at the
// top); chat-completions-style nested `{function:{…}}` is accepted as a
// fallback so captures of either shape read correctly.
function toolSummary(tool: unknown): ToolSchemaSummary | null {
  if (!isRecord(tool)) return null;
  const type = optionalString(tool.type) ?? 'unknown';
  if (type === 'function') {
    const fn = { ...tool, ...(isRecord(tool.function) ? tool.function : {}) };
    return Object.freeze({
      name: optionalString(fn.name) ?? '(unnamed function)',
      type,
      description: optionalString(fn.description),
      schemaJson: JSON.stringify(fn.parameters ?? {}),
    });
  }
  return Object.freeze({
    name: optionalString(tool.name) ?? `(built-in ${type})`,
    type,
    description: optionalString(tool.description),
    schemaJson: '{}',
  });
}

export function inspectCaptureRequest(requestText: string): CaptureRequestInspection {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(requestText);
    if (isRecord(parsed)) body = parsed;
  } catch {
    body = null;
  }
  if (body === null) {
    return Object.freeze({
      parsed: false,
      model: null,
      instructions: null,
      sessionId: null,
      messages: Object.freeze([]),
      tools: Object.freeze([]),
    });
  }
  return Object.freeze({
    parsed: true,
    model: optionalString(body.model),
    instructions: optionalString(body.instructions),
    sessionId: deriveSessionId(body),
    messages: Object.freeze(
      collectInputItems(body)
        .map(itemToMessage)
        .filter((message): message is InspectionMessage => message !== null),
    ),
    tools: Object.freeze(
      (Array.isArray(body.tools) ? body.tools : [])
        .map(toolSummary)
        .filter((tool): tool is ToolSchemaSummary => tool !== null),
    ),
  });
}

function outputItems(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  return Array.isArray(value.output) ? value.output : [];
}

function toolCallFromItem(item: unknown): InspectionToolCall | null {
  if (!isRecord(item)) return null;
  if (item.type !== 'function_call') return null;
  return Object.freeze({
    callId: optionalString(item.call_id),
    name: optionalString(item.name) ?? '(unknown)',
    argumentsText: typeof item.arguments === 'string' ? item.arguments : '',
  });
}

function isToolCallItem(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item.type === 'string' &&
    (item.type === 'function_call' || item.type.endsWith('tool_call'))
  );
}

// Response text may be a single Responses JSON document or an SSE stream of
// `data:` frames; both are accepted, everything else parses as absent.
export function inspectCaptureResponse(responseText: string): CaptureResponseInspection {
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(responseText));
  } catch {
    for (const line of responseText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload.length === 0 || payload === '[DONE]') continue;
      try {
        documents.push(JSON.parse(payload));
      } catch {
        // Skip malformed frames; remaining frames still contribute.
      }
    }
  }
  const items = documents.flatMap(outputItems);
  return Object.freeze({
    parsed: documents.length > 0,
    outputMessages: Object.freeze(
      items
        .filter((item) => !isToolCallItem(item))
        .map(itemToMessage)
        .filter((message): message is InspectionMessage => message !== null),
    ),
    toolCalls: Object.freeze(items.map(toolCallFromItem).filter((call): call is InspectionToolCall => call !== null)),
  });
}

const CHARS_PER_ESTIMATED_TOKEN = 4;

export function analyzePrompt(inspection: CaptureRequestInspection): PromptAnalysis {
  const inputChars = inspection.messages.reduce((total, message) => total + message.text.length, 0);
  const instructionsChars = inspection.instructions?.length ?? 0;
  return Object.freeze({
    parsed: inspection.parsed,
    model: inspection.model,
    instructionsPresent: inspection.instructions !== null,
    instructionsChars,
    inputMessageCount: inspection.messages.length,
    inputChars,
    toolCount: inspection.tools.length,
    estimatedInputTokens: Math.ceil((inputChars + instructionsChars) / CHARS_PER_ESTIMATED_TOKEN),
  });
}
