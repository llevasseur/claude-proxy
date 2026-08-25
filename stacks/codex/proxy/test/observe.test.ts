import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonResponseIdentity, makeSidecar, responsesRequestModel, SseResponseObserver } from '../src/observe.ts';

const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 20 },
  total_tokens: 130,
};

test('recognizes only structured Responses request and response values', () => {
  assert.equal(responsesRequestModel(Buffer.from('{"model":"gpt-5","input":"private"}')), 'gpt-5');
  assert.equal(responsesRequestModel(Buffer.from('{not json')), null);
  assert.equal(responsesRequestModel(Buffer.from('{"model":3}')), null);
  assert.deepEqual(jsonResponseIdentity(Buffer.from(JSON.stringify({ object: 'response', model: 'gpt-5', usage }))), {
    model: 'gpt-5',
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningOutputTokens: 20,
      totalTokens: 130,
    },
  });
  assert.equal(jsonResponseIdentity(Buffer.from(JSON.stringify({ object: 'future', model: 'gpt-5', usage }))), null);
});

test('extracts final authoritative usage from an SSE sequence split at arbitrary bytes', () => {
  const observer = new SseResponseObserver();
  const completed = `event: response.completed\r\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: { object: 'response', model: 'gpt-5', usage },
  })}\r\n\r\n`;
  const wire = `event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"private"}\r\n\r\n${completed}data: [DONE]\n\n`;
  for (let index = 0; index < wire.length; index += 7) observer.push(Buffer.from(wire.slice(index, index + 7)));

  assert.deepEqual(observer.finish(), {
    model: 'gpt-5',
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningOutputTokens: 20,
      totalTokens: 130,
    },
  });
});

test('ignores malformed usage and prices unknown models as unavailable', () => {
  const observer = new SseResponseObserver();
  observer.push(Buffer.from('event: future.event\ndata: not-json\n\n'));
  observer.push(
    Buffer.from(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { object: 'response', model: 'future-model', usage },
      })}\n\n`,
    ),
  );
  const identity = observer.finish();
  assert.ok(identity);
  assert.deepEqual(
    makeSidecar({
      endpoint: '/v1/responses',
      responseStatus: 200,
      requestId: null,
      identity,
      recordId: 'record-1',
      timestamp: '2026-08-19T12:00:00.000Z',
    }).costUnavailableReason,
    { code: 'unknown-model', model: 'future-model' },
  );
});
