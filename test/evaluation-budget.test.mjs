import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationCallBudget } from '../evaluation/call-budget.mjs';
test('shared evaluation budget reserves before concurrent execution and never refunds failure', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const budget = createEvaluationCallBudget(async request => {
    calls++; await gate;
    if (request.fail) throw new Error('provider failed');
    return request.value;
  }, 2);
  const pending = Promise.allSettled([budget.execute({ value: 1 }), budget.execute({ fail: true })]);
  await assert.rejects(budget.execute({ value: 3 }), /exhausted/);
  assert.equal(calls, 2); assert.deepEqual(budget.usage(), { used: 2, limit: 2, remaining: 0 });
  release(); const results = await pending;
  assert.equal(results[0].value, 1); assert.equal(results[1].status, 'rejected');
  await assert.rejects(budget.execute({}), /exhausted/); assert.equal(calls, 2);
});
test('pre-cancel does not consume budget; sync failure does; usage is isolated', async () => {
  const budget = createEvaluationCallBudget(() => { throw new Error('sync failure'); }, 1);
  const c = new AbortController(); c.abort(new Error('cancel'));
  await assert.rejects(budget.execute({ signal: c.signal }), /cancel/);
  assert.equal(budget.usage().used, 0);
  await assert.rejects(budget.execute({}), /sync failure/);
  budget.usage().used = 0; assert.equal(budget.usage().used, 1);
  for (const limit of [0, -1, 101, NaN, 1.5]) assert.throws(() => createEvaluationCallBudget(() => {}, limit), /Invalid/);
});
