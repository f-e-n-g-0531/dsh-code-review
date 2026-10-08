import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const snapshot = () => {
  const prefix = Array(2000).fill('unchanged line' + String.fromCharCode(10)).join('');
  return { id: 's', vcs: 'git', context: [], files: [{ id: 'f', path: 'large.js', eligibility: 'reviewable', properties: [], left: { text: prefix + 'before' }, right: { text: prefix + 'after' } }] };
};
test('oversized full input uses all exact windows with original attribution and preview parity', async () => {
  const s = snapshot(), scope = createRetrievalScope(s);
  const plan = buildCoveragePlan(s, { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 12000 });
  assert.equal(plan.items[0].status, 'ready');
  assert.equal(plan.items[0].sourceMode, 'change-windows');
  const report = await reviewSnapshot(s, async request => {
    const p = JSON.parse(request.input);
    assert.equal(p.file.right.text, undefined);
    assert.equal(p.sourceMode, 'change-windows');
    assert.ok(p.windows[0].new.start > 1900);
    return { findings: [{ fileId: 'f', severity: 'medium', title: 'regression', evidence: 'after', trigger: 'run', impact: 'failure', suggestion: 'restore', anchor: { kind: 'line', side: 'new', start: 2001, end: 2001, snippet: 'after' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'before', afterBehavior: 'after', reason: 'changed' } }], limitations: [] };
  }, { enableRetrieval: true, maxInputBytes: 12000 });
  assert.equal(report.status, 'completed');
  assert.equal(report.findings[0].anchor.start, 2001);
  assert.equal(report.files[0].initialInputBytes, plan.items[0].initialInputBytes);
  assert.equal(report.files[0].windowCoverage.completed.length, 1);
});
test('invalid response leaves every prepared window explicitly pending', async () => {
  const report = await reviewSnapshot(snapshot(), async () => ({ invalid: true }), { enableRetrieval: true, maxInputBytes: 12000 });
  assert.equal(report.files[0].status, 'failed');
  assert.deepEqual(report.files[0].windowCoverage.completed, []);
  assert.equal(report.files[0].windowCoverage.pending.length, 1);
});
test('no approved retrieval or window input still too large blocks without a send', async () => {
  for (const options of [{ maxInputBytes: 12000 }, { enableRetrieval: true, maxInputBytes: 10 }]) {
    const report = await reviewSnapshot(snapshot(), () => assert.fail('unexpected send'), options);
    assert.equal(report.files[0].status, 'blocked');
    assert.equal(report.files[0].windowCoverage, undefined);
  }
});
