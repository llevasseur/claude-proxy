// Redaction runs on captured body text BEFORE persistence. Rules are pure
// string transforms so Boat can prove by test that credentials, cookies, and
// authorization material never survive capture (ADR 0002 keeps the sidecar
// itself body-free; this guards the separately stored capture envelopes).
export const CAPTURE_REDACTION_SENTINEL = "[redacted]";

// Every pattern compiles with the "gi" flags. Field names stay readable for
// inspection; only their values are replaced with the sentinel.
const DEFAULT_REDACTION_PATTERNS: readonly string[] = [
  // JSON-shaped credential fields: "authorization": "Bearer ..." and kin.
  String.raw`("(?:[\w.-]*(?:authorization|cookie|api[-_]?key|apikey|token|secret|password|passwd|credential)[\w.-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"`,
  // Header-style lines embedded in text bodies: authorization: ..., cookie: ....
  String.raw`\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*)[^\r\n",}\]]+`,
  // Cookie-style assignments anywhere in text: session_cookie=..., csrftoken=....
  String.raw`([\w.-]*(?:cookie|csrf|sessionid)[\w.-]*\s*=\s*)[^\s'",;&}\]]+`,
  // Authorization schemes with long credential material.
  String.raw`\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}`,
  // OpenAI-style key prefixes.
  String.raw`\bsk-[A-Za-z0-9_-]{12,}`,
];

export function compileRedactionPatterns(extraPatterns: readonly string[] = []): RegExp[] {
  return [...DEFAULT_REDACTION_PATTERNS, ...extraPatterns].map(
    (source) => new RegExp(source, "gi"),
  );
}

export function redactCapturedText(text: string, extraPatterns: readonly string[] = []): string {
  let output = text;
  for (const pattern of compileRedactionPatterns(extraPatterns)) {
    output = output.replace(pattern, (...args: unknown[]) => {
      const kept = typeof args[1] === "string" ? args[1] : null;
      return kept === null ? CAPTURE_REDACTION_SENTINEL : `${kept}${CAPTURE_REDACTION_SENTINEL}`;
    });
    pattern.lastIndex = 0;
  }
  return output;
}
