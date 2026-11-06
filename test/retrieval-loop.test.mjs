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
  let count = 0, limited = 0; const reader = scope();
  await assert.rejects(retrievalLoop(async () => { count++; return read; }, request, reader, { maxRounds: 1, onBudgetLimited: info => { assert.equal(info.code, 'RETRIEVAL_ROUND_BUDGET_EXCEEDED'); limited++; } }), /round budget/);
  assert.equal(count, 3); assert.equal(limited, 1); assert.equal(reader.usage().calls, 1);
  await assert.rejects(retrievalLoop(() => assert.fail('no call'), request, scope(), { maxInputBytes: 1 }), /input budget/);
});
test('exactly N successful reads permit natural final without claiming a denied retrieval', async () => {
  const reader = scope(); let calls = 0, limited = 0;
  const result = await retrievalLoop(r => {
    calls++; const input = JSON.parse(r.input);
    if (calls === 1) return read;
    assert.equal(input.retrievalRounds.remaining, 0); assert.equal(input.retrievalFinalization, undefined);
    return { findings: [], limitations: [] };
  }, request, reader, { maxRounds: 1, onBudgetLimited: () => limited++ });
  assert.deepEqual(result, { findings: [], limitations: [] }); assert.equal(calls, 2); assert.equal(limited, 0); assert.equal(reader.usage().calls, 1);
});
test('cancellation after model returns prevents retrieval execution', async () => {
  const controller = new AbortController(), reader = scope();
  await assert.rejects(retrievalLoop(async () => { controller.abort(); return read; }, { ...request, signal: controller.signal }, reader), /abort/i);
  assert.equal(reader.usage().calls, 0);
});
