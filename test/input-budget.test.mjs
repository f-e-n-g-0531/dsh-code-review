import test from 'node:test';
import assert from 'node:assert/strict';
import { initialInputBudget } from '../src/input-budget.mjs';
import { initialRetrievalEnvelope } from '../src/retrieval-initial-envelope.mjs';
test('initial budget counts exact UTF8 instructions and retrieval envelope', () => {
  const request = { instructions: '只读', input: JSON.stringify({ rules: [{ text: '规则' }] }) };
  const scope = { catalog: () => [{ id: 's1', path: '中文.js' }] };
  const actual = initialRetrievalEnvelope(request, scope);
  const bytes = Buffer.byteLength(actual.input) + Buffer.byteLength(actual.instructions);
  assert.deepEqual(initialInputBudget(request, scope, bytes), { bytes, maxBytes: bytes, fits: true });
  assert.equal(initialInputBudget(request, scope, bytes - 1).fits, false);
  assert.ok(initialInputBudget(request, null, bytes).bytes < bytes);
  assert.throws(() => initialInputBudget(request, scope, NaN), /Invalid/);
});
