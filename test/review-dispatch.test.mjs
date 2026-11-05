import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReviewDispatch } from '../src/review-dispatch.mjs';
import { prepareWholeScope } from '../src/whole-scope-plan.mjs';
const plan = (groups = [['a']], oversized = []) => ({ wholeScope: true, batches: groups.map(fileIds => ({ fileIds })), oversized: oversized.map(fileId => ({ fileId, path: fileId, requiredBytes: 999999 })) });
test('default fresh single complete batch is direct whole scope, never a fake child', () => {
  const result = resolveReviewDispatch({ wholePlan: plan(), sourceBytes: 100 });
  assert.equal(result.requested, 'auto'); assert.equal(result.effectiveStrategy, 'whole-scope');
  assert.equal(result.childMode, 'direct'); assert.equal(result.plannedChildCount, 0); assert.equal(result.eligibleCount, 1);
});
test('multiple fitting batches plan bounded real host children, independent of completion', () => {
  const result = resolveReviewDispatch({ wholePlan: plan([['a'], ['b'], ['c']]), hostAvailable: true, concurrency: 2 });
  assert.equal(result.effectiveStrategy, 'whole-scope'); assert.equal(result.childMode, 'host-subagents');
  assert.equal(result.plannedChildCount, 3); assert.equal(result.concurrency, 2);
  assert.throws(() => resolveReviewDispatch({ wholePlan: plan([['a'], ['b']]) }), e => e.code === 'REVIEW_SUBAGENTS_UNAVAILABLE');
});
test('fifteen oversized complete files transparently retain staged coverage instead of discarding files', () => {
  const result = resolveReviewDispatch({ wholePlan: plan([['fit']], Array.from({ length: 15 }, (_, i) => 'large-' + i)), hostAvailable: true });
  assert.equal(result.effectiveStrategy, 'staged'); assert.equal(result.reason, 'complete-files-exceed-capacity');
  assert.equal(result.eligibleCount, 16); assert.equal(result.oversizedCount, 15); assert.equal(result.childMode, 'none');
  assert.equal(result.plannedChildCount, 0);
});
test('auto project resume and multiround keep staged with explicit reasons; no plan needed', () => {
  for (const [options, reason] of [[{ mode: 'project' }, 'project-requires-staged'], [{ resume: true }, 'resume-requires-staged'], [{ rounds: 2 }, 'multiple-rounds-require-staged']]) {
    assert.equal(resolveReviewDispatch(options).reason, reason);
    assert.equal(resolveReviewDispatch(options).effectiveStrategy, 'staged');
    assert.throws(() => resolveReviewDispatch({ ...options, requested: 'whole-scope' }), e => e.code === 'WHOLE_SCOPE_UNSUPPORTED');
  }
});
test('explicit policies preserved including explicit whole oversized blocking semantics', () => {
  assert.equal(resolveReviewDispatch({ requested: 'staged' }).reason, 'explicit-staged');
  const result = resolveReviewDispatch({ requested: 'whole-scope', wholePlan: plan([['fit']], ['large']) });
  assert.equal(result.effectiveStrategy, 'whole-scope'); assert.equal(result.oversizedCount, 1);
  assert.equal(result.reason, 'explicit-whole-scope');
});
test('empty scope and real whole-scope planner shape accepted without leaking payload', () => {
  assert.equal(resolveReviewDispatch({ wholePlan: plan([]) }).reason, 'no-eligible-files');
  const snapshot = { id: 's', context: [], files: [{ id: 'a', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'PRIVATE_SOURCE();' } }] };
  const wholePlan = prepareWholeScope(snapshot, { instructions: 'Review', maxInputBytes: 98304 });
  const before = structuredClone(wholePlan), result = resolveReviewDispatch({ wholePlan });
  assert.equal(result.effectiveStrategy, 'whole-scope'); assert.deepEqual(wholePlan, before);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SOURCE')); assert.ok(Object.isFrozen(result));
});
test('unknown policies malformed budgets and duplicate plan memberships fail closed', () => {
  for (const options of [{ requested: 'guess' }, { mode: 'other' }, { rounds: 0 }, { resume: 'id' }, { hostAvailable: 1 }, { concurrency: 5 }, { sourceBytes: -1 }, { model: 'guess-capacity' }, {}]) assert.throws(() => resolveReviewDispatch(options));
  for (const wholePlan of [{}, plan([[]]), plan([['a'], ['a']]), plan([['a']], ['a']), plan([['']])]) assert.throws(() => resolveReviewDispatch({ wholePlan }));
});
