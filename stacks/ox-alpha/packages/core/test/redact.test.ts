import { describe, expect, test } from 'vitest';
import { CAPTURE_REDACTION_SENTINEL, compileRedactionPatterns, redactCapturedText } from '../src/redact.ts';

const SECRETS = [
  'Bearer sk-proj-abcdef0123456789',
  'authorization": "Bearer super-secret-token-value"',
  'session_cookie=7c1f9a2e44d5b6',
  'x-api-key: op-secret-key-material',
];

function survives(output: string): string[] {
  return SECRETS.filter((secret) => output.includes(secret));
}

describe('capture redaction', () => {
  test('removes authorization material, cookies, and API keys before persistence', () => {
    const body = [
      '{"model":"gpt-5",',
      '"authorization":"Bearer sk-live-deadb33fc0ffee00",',
      '"cookie":"session_cookie=7c1f9a2e44d5b6; csrftoken=99aa88bb",',
      '"nested":{"api_key":"sk-proj-abcdef0123456789"},',
      '"headers":{"X-Api-Key":"op-secret-key-material"}}',
    ].join('');
    const output = redactCapturedText(body);
    expect(survives(output)).toEqual([]);
    expect(survives(output.toLowerCase())).toEqual([]);
  });

  test('redacts header-style credential lines while keeping field names readable', () => {
    const body = 'POST /v1/responses\nauthorization: Bearer abc123def456ghi\ncookie: a=b; c=d\n{"input":"hi"}';
    const output = redactCapturedText(body);
    expect(output).toContain(`authorization: ${CAPTURE_REDACTION_SENTINEL}`);
    expect(output).toContain(`cookie: ${CAPTURE_REDACTION_SENTINEL}`);
    expect(output).not.toContain('abc123def456ghi');
    expect(output).not.toContain('a=b');
    expect(output).toContain('{"input":"hi"}');
  });

  test('keeps non-credential content untouched', () => {
    const body = '{"model":"gpt-5","input":"explain bearer bonds in finance","usage":{"tokens":5}}';
    expect(redactCapturedText(body)).toBe(body);
  });

  test('applies configurable patterns with the same sentinel', () => {
    const body = '{"note":"OPENSECRET-42 and normal text"}';
    const output = redactCapturedText(body, ['OPENSECRET-[0-9]+']);
    expect(output).toBe(`{"note":"${CAPTURE_REDACTION_SENTINEL} and normal text"}`);
  });

  test('rejects uncompilable configurable patterns instead of silently skipping them', () => {
    expect(() => compileRedactionPatterns(['([unclosed'])).toThrow();
  });

  test('secrets never survive a mixed capture when enabled', () => {
    const request = JSON.stringify({
      model: 'gpt-5',
      input: SECRETS.join('\n'),
    });
    const response = JSON.stringify({ echo: SECRETS.join('|'), output_text: 'safe tail' });
    const output = redactCapturedText(`${request}\n${response}`);
    expect(survives(output)).toEqual([]);
    expect(survives(output.toLowerCase())).toEqual([]);
    expect(output).toContain('safe tail');
  });
});
