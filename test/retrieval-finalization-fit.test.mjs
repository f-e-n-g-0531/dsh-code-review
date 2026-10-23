import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalLoop, retrievalRequest } from '../src/retrieval-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
test('exhausted shared reader finalization fits an admitted nearly full source envelope without duplicate ledger', async () => {
  const scope = createRetrievalScope({ id: 's', files: [], context: [{ path: 'helper', text: 'x' }] }, { maxCalls: 1 });
  scope.read({ id: 's1', start: 1, count: 1 });
  const request = { instructions: 'review', input: JSON.stringify({ file: { id: 'f', left: { text: 'a'.repeat(5000) }, right: { text: 'b'.repeat(5000) } } }) };
  const envelope = retrievalRequest(request, scope);
  const maxInputBytes = Buffer.byteLength(envelope.input) + Buffer.byteLength(envelope.instructions) + 100;
  let calls = 0, limited = 0;
  const result = await retrievalLoop(async req => {
    calls++; assert.ok(Buffer.byteLength(req.input) + Buffer.byteLength(req.instructions) <= maxInputBytes);
    const p = JSON.parse(req.input);
    assert.equal(p.file.left.text, 'a'.repeat(5000));
    assert.equal(p.file.right.text, 'b'.repeat(5000));
    assert.equal(p.retrievalFinalization.code, 'READER_CALL_BUDGET_EXCEEDED');
    assert.equal(p.retrievalFinalization.budget, undefined);
    assert.equal(p.retrievalBudget.remainingCalls, 0);
    assert.match(req.instructions, /不得再返回requests/);
    return { findings: [], limitations: ['No more reads; conditions remain unverified'] };
  }, request, scope, { correctProtocol: true, maxInputBytes, onBudgetLimited: () => limited++ });
  assert.equal(calls, 1); assert.equal(limited, 1); assert.equal(scope.usage().calls, 1); assert.equal(result.limitations.length, 1);
});
