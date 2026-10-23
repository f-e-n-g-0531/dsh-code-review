import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { RISK_PLAN_INSTRUCTIONS } from '../src/risk-plan.mjs';

function fixture() {
  const before = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
  const after = [...before]; after[10] = 'changed10'; after[80] = 'changed80';
  return { id: 's', vcs: 'git', context: [], files: [{ id: 'f', path: 'large.js', eligibility: 'reviewable', properties: [],
    left: { text: before.join('\n') }, right: { text: after.join('\n') }, rightExists: true }] };
}
const options = { enableRetrieval: true, enableRiskPlanning: true, maxInputBytes: 10000 };
const final = () => ({ findings: [], limitations: [] });
const isPlan = request => request.instructions.startsWith(RISK_PLAN_INSTRUCTIONS);
const risk = (editIds = ['e2'], sourceIds = []) => ({ id: 'r', fileIds: ['f'],
  editRefs: editIds.map(editId => ({ fileId: 'f', editId })), question: 'Do the edits preserve behavior?',
  trigger: 'changed path executes', impact: 'incorrect result', checks: ['Check matching source sides'], sourceIds });
function preview(input, config = options) {
  return buildCoveragePlan(input, { ...config, instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(input) });
}

test('two primary windows and synthesis share one empty canonical plan with exact preview minimum', async () => {
  const input = fixture(); let planCalls = 0, primaryCalls = 0, synthesisCalls = 0;
  const report = await reviewSnapshot(input, request => {
    const payload = JSON.parse(request.input);
    if (isPlan(request)) {
      planCalls++;
      assert.equal(payload.sourceMode, 'risk-all-edits');
      assert.deepEqual(payload.changes.edits.map(edit => edit.id), ['e1', 'e2']);
      assert.equal(payload.file.right.text, undefined);
      return { risks: [] };
    }
    if (payload.sourceMode === 'window-synthesis') synthesisCalls++;
    else { primaryCalls++; assert.deepEqual(payload.riskPlan, []); }
    return final();
  }, options);
  assert.equal(report.status, 'completed');
  assert.equal(planCalls, 1);
  assert.equal(primaryCalls, 2);
  assert.equal(synthesisCalls, 1);
  assert.equal(report.modelCalls, 4);
  assert.equal(preview(input).minimumCalls, report.modelCalls);
  assert.equal(report.files[0].riskPlans.length, 1);
  assert.equal(report.files[0].riskPlans[0].generations.length, 2);
});

test('later edit hypotheses are generated from complete canonical scope and enter their later primary window', async () => {
  let planCalls = 0; const windows = [];
  const report = await reviewSnapshot(fixture(), request => {
    const payload = JSON.parse(request.input);
    if (isPlan(request)) {
      planCalls++;
      assert.equal(payload.changes.edits[1].new.start, 81);
      return { risks: [risk()] };
    }
    if (payload.sourceMode === 'change-windows') {
      const editIds = payload.windows.flatMap(window => window.editIds);
      windows.push(editIds);
      assert.equal(payload.riskPlan.length, editIds.includes('e2') ? 1 : 0);
      if (editIds.includes('e2')) assert.equal(payload.riskPlan[0].status, 'hypothesis');
    }
    return final();
  }, options);
  assert.equal(planCalls, 1);
  assert.deepEqual(windows, [['e1'], ['e2']]);
  assert.equal(report.files[0].riskPlans[0].risks.length, 1);
  assert.equal(report.status, 'completed');
});

test('invalid canonical planning response is cached fallback, not retried separately for later windows', async () => {
  let planCalls = 0, primaryCalls = 0;
  const report = await reviewSnapshot(fixture(), request => {
    if (isPlan(request)) { planCalls++; return { risks: [{ invalid: true }] }; }
    const payload = JSON.parse(request.input);
    if (payload.sourceMode === 'change-windows') {
      primaryCalls++;
      assert.equal(payload.riskPlan, undefined);
    }
    return final();
  }, options);
  assert.equal(report.status, 'partial', 'planning failure remains an explicit limitation');
  assert.equal(report.coverage.completed, 1);
  assert.equal(planCalls, 1);
  assert.equal(primaryCalls, 2);
  assert.equal(report.files[0].riskPlans.length, 1);
  assert.equal(report.files[0].riskPlans[0].status, 'fallback');
  assert.equal(report.modelCalls, 4);
});

test('risk read receipts remain per generation and an earlier window read cannot satisfy a later window', async () => {
  let planCalls = 0;
  const report = await reviewSnapshot(fixture(), request => {
    const payload = JSON.parse(request.input);
    if (isPlan(request)) { planCalls++; return { risks: [risk(['e1', 'e2'], ['s2'])] }; }
    if (payload.sourceMode === 'change-windows') {
      assert.equal(payload.riskPlan.length, 1);
      if (payload.windows[0].editIds.includes('e1') && !payload.retrieved.length) {
        return { requests: [{ kind: 'read', id: 's2', start: 11, count: 1 }] };
      }
    }
    return final();
  }, options);
  assert.equal(planCalls, 1);
  assert.equal(report.status, 'partial', 'unread requested source remains a limitation');
  assert.equal(report.coverage.completed, 1);
  assert.equal(report.retrievalUsage.calls, 1);
  const plan = report.files[0].riskPlans[0];
  assert.equal(plan.generations.length, 2);
  assert.equal(plan.sourceReadCoverage, undefined, 'no union across generations');
  assert.deepEqual(plan.generations[0].coverage[0].readSourceIds, ['s2']);
  assert.equal(plan.generations[0].coverage[0].status, 'fragments-read');
  assert.deepEqual(plan.generations[1].coverage[0].unreadSourceIds, ['s2']);
  assert.equal(plan.generations[1].coverage[0].status, 'unread-sources');
  assert.equal(plan.generations[1].coverage[0].conditions, 'unverified');
});

test('canonical planning is invocation-local and later independent rounds do not inherit first-round hypotheses', async () => {
  let planCalls = 0;
  for (let invocation = 0; invocation < 2; invocation++) {
    let primaryCalls = 0;
    const input = fixture(); input.id += invocation;
    const report = await reviewSnapshot(input, request => {
      const payload = JSON.parse(request.input);
      if (isPlan(request)) { planCalls++; return { risks: [risk()] }; }
      if (payload.sourceMode === 'change-windows') {
        primaryCalls++;
        if (primaryCalls > 2) assert.equal(payload.riskPlan, undefined);
      }
      return final();
    }, { ...options, reviewRounds: 2 });
    assert.equal(report.status, 'completed');
    assert.equal(primaryCalls, 4);
    assert.equal(report.modelCalls, preview(input, { ...options, reviewRounds: 2 }).minimumCalls);
  }
  assert.equal(planCalls, 2);
});

test('canonical metadata overflow retains per-window planning fallback and its truthful preview minimum', async () => {
  const input = fixture();
  input.history = { mode: 'range', semantics: 'metadata'.repeat(5000) };
  const prepared = preparePrimaryInput(input, input.files[0], { ...options, instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(input) });
  assert.equal(prepared.batches.length, 2);
  let planCalls = 0;
  const report = await reviewSnapshot(input, request => {
    if (isPlan(request)) {
      planCalls++;
      assert.equal(JSON.parse(request.input).sourceMode, 'change-windows');
      return { risks: [] };
    }
    return final();
  }, options);
  assert.equal(report.status, 'completed');
  assert.equal(planCalls, 2);
  assert.equal(report.files[0].riskPlans.length, 2);
  assert.equal(report.modelCalls, preview(input).minimumCalls);
});
