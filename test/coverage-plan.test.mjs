import test from 'node:test';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { buildReviewGroups } from '../src/review-groups.mjs';
import { inferTestRelations } from '../src/file-relations.mjs';
import assert from 'node:assert/strict';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] };
const options = { instructions: '只读', maxInputBytes: 10000 };
test('plan shares exact preparation and does not retain source bodies', () => {
  const input = { id: 's', files: [file, { id: 'b', path: 'secret', eligibility: 'excluded' }] };
  const p = buildCoveragePlan(input, options);
  assert.equal(p.items[0].initialInputBytes, preparePrimaryInput(input, file, options).budget.bytes);
  assert.equal(p.minimumCalls, 1);
  assert.equal(p.items[1].status, 'excluded');
  assert.ok(!JSON.stringify(p).includes('old'));
  assert.deepEqual(p, buildCoveragePlan({ ...input, files: [...input.files].reverse() }, options));
  const blocked = buildCoveragePlan(input, { ...options, maxInputBytes: 1 });
  assert.equal(blocked.items[0].status, 'input-blocked'); assert.equal(blocked.minimumCalls, 0);
});
test('group fallback plan matches actual retrieval-enabled execution', async () => {
  const input = { id: 's', vcs: 'git', context: [], rules: [{ path: 'rules.md', text: 'Bound resources', hash: 'fixture' }], files: [file, { ...file, id: 'b', path: 'a.test.js', left: { text: 'x'.repeat(5000) }, right: { text: 'y'.repeat(5000) } }] };
  const scope = createRetrievalScope(input);
  const grouping = buildReviewGroups(input.files, inferTestRelations(input.files));
  const config = { instructions: REVIEW_INSTRUCTIONS, scope, grouping, maxInputBytes: 96000 };
  const single = preparePrimaryInput(input, file, { ...config, grouping: undefined });
  const maxInputBytes = single.budget.bytes;
  const plan = buildCoveragePlan(input, { ...config, maxInputBytes });
  assert.equal(plan.items[0].groupFallback, 'input-budget');
  assert.equal(plan.items[0].status, 'ready');
  assert.equal(plan.items[1].status, 'input-blocked');
  let calls = 0;
  const report = await reviewSnapshot(input, async () => { calls++; return { findings: [], limitations: [] }; }, { enableRetrieval: true, enableGrouping: true, maxInputBytes });
  assert.equal(calls, 1);
  for (const item of plan.items) {
    const state = report.files.find(f => f.fileId === item.fileId);
    assert.equal(state.initialInputBytes, item.initialInputBytes);
    assert.equal(state.groupFallback, item.groupFallback);
  }
  assert.equal(scope.usage().calls, 0);
});
test('plan rejects ambiguous snapshots and honors cancellation', () => {
  assert.throws(() => buildCoveragePlan({ id: 's', files: [file,file] }, options), /Invalid/);
  const c = new AbortController(); c.abort(new Error('cancel plan'));
  assert.throws(() => buildCoveragePlan({ id: 's', files: [file] }, { ...options, signal: c.signal }), /cancel plan/);
});
