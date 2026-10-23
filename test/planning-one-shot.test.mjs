import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
const snapshot = () => ({ id: 'approved', vcs: 'svn', context: [], files: [{ id: 'f', path: 'a.cpp', eligibility: 'reviewable', properties: [], left: { text: 'int old;' }, right: { text: 'int current;' } }] });
const final = { findings: [], limitations: [] };
test('planning cannot spend shared reads or retrieval rounds and primary still reads approved evidence', async () => {
  const calls = [];
  const r = await reviewSnapshot(snapshot(), async request => {
    const p = JSON.parse(request.input); calls.push(request.reviewPhase);
    if (request.reviewPhase === 'risk-planning') {
      assert.ok(p.catalog.some(s => s.fileId === 'f'));
      assert.equal(p.retrievalBudget, undefined);
      assert.doesNotMatch(request.instructions, /retrievalBudget/);
      return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] };
    }
    if (!p.retrieved.length) return { requests: [{ kind: 'read', id: 's2', start: 1, count: 1 }] };
    assert.equal(p.retrieved[0].result.text, 'int current;');
    return final;
  }, { enableRetrieval: true, enableRiskPlanning: true, correctProtocol: true });
  assert.deepEqual(calls, ['risk-planning', 'primary', 'primary']);
  assert.equal(r.retrievalUsage.calls, 1);
  assert.equal(r.files[0].riskPlans[0].status, 'fallback');
  assert.equal(r.files[0].status, 'completed');
  assert.equal(r.status, 'partial');
  assert.equal(r.diagnostics.planning.fallback, 1);
  assert.match(markdownReport(r), /执行诊断/);
});
test('valid unverified question retains source requirement and model budget is still shared', async () => {
  let calls = 0;
  const r = await reviewSnapshot(snapshot(), async request => {
    calls++;
    if (request.reviewPhase === 'risk-planning') return { risks: [{ id: 'r', fileIds: ['f'], editRefs: [{ fileId: 'f', editId: 'e1' }], question: 'Guard?', trigger: 'active', impact: 'failure', checks: ['Read guard'], sourceIds: ['s2'] }] };
    assert.equal(JSON.parse(request.input).riskPlan[0].causality, 'unverified');
    return final;
  }, { enableRetrieval: true, enableRiskPlanning: true, maxCalls: 2 });
  assert.equal(calls, 2); assert.equal(r.modelCalls, 2);
  assert.equal(r.status, 'partial');
  assert.equal(r.files[0].riskPlans[0].sourceReadCoverage[0].status, 'unread-sources');
});
