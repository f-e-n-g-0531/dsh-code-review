import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForRegistry } from '../scripts/registry-wait.mjs';
const ok = () => new Response(JSON.stringify({ dist: { integrity: 'expected' } }));
test('registry propagation retries are bounded and preserve exact integrity', async () => {
  let calls = 0, sleeps = 0;
  await waitForRegistry('url', 'expected', { fetchImpl: async () => ++calls < 3 ? new Response('', { status: 404 }) : ok(), sleep: async () => sleeps++ });
  assert.equal(calls, 3); assert.equal(sleeps, 2);
});
test('mismatch and permanent failures fail immediately; exhaustion never passes', async () => {
  for (const response of [new Response('{}'), new Response('', { status: 403 })]) {
    await assert.rejects(waitForRegistry('url', 'expected', { fetchImpl: async () => response, sleep: () => assert.fail('must not retry') }));
  }
  let calls = 0;
  await assert.rejects(waitForRegistry('url', 'expected', { attempts: 2, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); }, sleep: async () => {} }), /HTTP 404/);
  assert.equal(calls, 2);
});
