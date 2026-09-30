import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalLoop } from '../src/retrieval-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const scope = () => createRetrievalScope({ id: 's', files: [], context: [{ path: 'helper', text: 'answer' }] });
const request = { instructions: 'review', input: '{}' };
const read = { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] };
test('bounded loop returns retrieved provenance to next call and counts all calls', async () => {
  let count = 0;
  const result = await retrievalLoop(async r => {
    const p = JSON.parse(r.input);
    if (count === 1) return read;
    assert.equal(p.retrieved[0].result.text, 'answer');
    return { findings: [], limitations: [] };
  }, request, scope(), { beforeCall: () => count++ });
  assert.equal(count, 2); assert.deepEqual(result.findings, []);
});
test('round and input budgets prevent unbounded follow-up calls', async () => {
  let count = 0;
  await assert.rejects(retrievalLoop(async () => { count++; return read; }, request, scope(), { maxRounds: 1 }), /round budget/);
  assert.equal(count, 2);
  await assert.rejects(retrievalLoop(() => assert.fail('no call'), request, scope(), { maxInputBytes: 1 }), /input budget/);
});
test('cancellation after model returns prevents retrieval execution', async () => {
  const controller = new AbortController(), reader = scope();
  await assert.rejects(retrievalLoop(async () => { controller.abort(); return read; }, { ...request, signal: controller.signal }, reader), /abort/i);
  assert.equal(reader.usage().calls, 0);
});
