import test from 'node:test';
import { reviewSnapshot } from '../src/review.mjs';
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
test('shared counter spans generation, verification and a subsequent snapshot', async () => {
  const snapshot = { id: 'one', vcs: 'git', context: [], files: [{ id: 'f', path: 'subject.mjs', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }] };
  let calls = 0;
  const budget = createEvaluationCallBudget(async request => {
    calls++;
    const input = JSON.parse(request.input);
    if (input.candidates) return { verdicts: [{ candidateId: input.candidates[0].candidateId, verdict: 'uncertain', reason: 'Missing context', evidence: [] }] };
    return { findings: [{ fileId: 'f', severity: 'high', title: 'Candidate', evidence: 'e', trigger: 't', impact: 'i', suggestion: 's', anchor: { kind: 'file' } }], limitations: [] };
  }, 2);
  const options = { enableRetrieval: true, enableVerification: true };
  const first = await reviewSnapshot(snapshot, budget.execute, options);
  assert.equal(calls, 2); assert.equal(first.findings[0].verification.verdict, 'uncertain');
  const second = await reviewSnapshot({ ...snapshot, id: 'two' }, budget.execute, options);
  assert.equal(calls, 2); assert.equal(budget.usage().used, 2);
  assert.equal(second.coverage.failed, 1);
  assert.match(second.files[0].reason, /budget exhausted/);
  assert.deepEqual(second.followup.suggestedPaths, ['subject.mjs']);
  // Core report counts executor attempts; the shared counter counts forwarded calls.
  assert.equal(second.modelCalls, 1);
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
