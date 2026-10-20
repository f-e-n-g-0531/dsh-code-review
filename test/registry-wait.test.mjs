import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForRegistry } from '../scripts/registry-wait.mjs';
const ok = () => new Response(JSON.stringify({ dist: { integrity: 'expected' } }));
test('registry propagation retries are bounded and preserve exact integrity', async () => {
  let calls = 0, sleeps = 0;
  await waitForRegistry('url', 'expected', { fetchImpl: async () => ++calls < 3 ? new Response('', { status: 404 }) : ok(), sleep: async () => sleeps++ });
  assert.equal(calls, 3); assert.equal(sleeps, 2);
});
test('metadata fetch rejection retries within budget with fresh timeout signals', async () => {
  const failure = new TypeError('fetch failed'), signals = [], delays = [];
  let calls = 0;
  await waitForRegistry('url', 'expected', { attempts: 2, delayMs: 7,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'url'); assert.equal(options.cache, 'no-store'); signals.push(options.signal);
      if (++calls === 1) throw failure;
      return ok();
    }, sleep: async delay => delays.push(delay),
  });
  assert.equal(calls, 2); assert.deepEqual(delays, [7]); assert.notEqual(signals[0], signals[1]);
});
test('metadata fetch exhaustion preserves final error and skips final sleep', async () => {
  const failures = [new TypeError('network'), new DOMException('timed out', 'TimeoutError')];
  let calls = 0, sleeps = 0;
  await assert.rejects(waitForRegistry('url', 'expected', { attempts: 2,
    fetchImpl: async () => { throw failures[calls++]; }, sleep: async () => sleeps++,
  }), error => error === failures[1]);
  assert.equal(calls, 2); assert.equal(sleeps, 1);
});
test('invalid metadata is not retried as a fetch failure', async () => {
  let calls = 0;
  await assert.rejects(waitForRegistry('url', 'expected', {
    fetchImpl: async () => { calls++; return new Response('not json'); },
    sleep: async () => assert.fail('invalid metadata must fail immediately'),
  }), SyntaxError);
  assert.equal(calls, 1);
});
test('mismatch and permanent failures fail immediately; exhaustion never passes', async () => {
  for (const response of [new Response('{}'), new Response('', { status: 403 })]) {
    await assert.rejects(waitForRegistry('url', 'expected', { fetchImpl: async () => response, sleep: () => assert.fail('must not retry') }));
  }
  let calls = 0;
  await assert.rejects(waitForRegistry('url', 'expected', { attempts: 2, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); }, sleep: async () => {} }), /HTTP 404/);
  assert.equal(calls, 2);
});
