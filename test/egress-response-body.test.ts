import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discardResponseBody } from '../src/egress/transport.ts';

test('discardResponseBody cancels a status-only response stream', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('unneeded body'));
    },
    cancel() {
      cancelled = true;
    },
  }));
  await discardResponseBody(response);
  assert.equal(cancelled, true);
});

test('discardResponseBody is safe for an empty response body', async () => {
  await discardResponseBody(new Response(null));
});
