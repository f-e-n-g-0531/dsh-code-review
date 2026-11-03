import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createReviewReaderAllocation } from '../src/review-reader-allocation.mjs';

const request = { kind: 'read', id: 's2', start: 1, count: 1 };
const make = (options = {}) => createRetrievalScope({ id: 's', context: [], files: [{ id: 'f', path: 'f.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' } }] }, { maxCalls: 8, maxOutputBytes: 20000, ...options });
const units = ['verify', 'primary', 'peer', 'future'].map(id => ({ id, weight: 1 }));

test('host complete readiness skips blocked verification FIFO head but preserves its reserve', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units);
  allocation.yield('verify'); allocation.yield('primary'); allocation.release('peer');
  const before = root.usage(), limits = root.budget();
  assert.equal(allocation.resume('primary', [request]).reason, 'READER_RESUME_WAITING');
  assert.deepEqual(allocation.resume('verify', [request], { eligibleIds: ['primary'] }), { resumed: false, reason: 'READER_RESUME_WAITING', attempts: 0 });
  assert.deepEqual(allocation.resume('primary', [request], { eligibleIds: ['primary'] }), { resumed: true, reason: null, attempts: 1 });
  assert.deepEqual(root.usage(), before); assert.deepEqual(root.budget(), limits);
  const primary = allocation.scope('primary');
  assert.equal(primary.budget().remainingCalls, 4);
  for (let i = 0; i < 4; i++) primary.read(request);
  assert.throws(() => primary.read(request), { code: 'READER_CALL_BUDGET_EXCEEDED' });
  assert.equal(allocation.summary().releasedUnits, 1);
  assert.equal(allocation.scope('future').budget().remainingCalls, 2);
  assert.equal(allocation.resume('verify', [request], { eligibleIds: ['verify'] }).resumed, true);
  assert.equal(allocation.scope('verify').budget().remainingCalls, 2);
  assert.equal(root.budget().maxCalls, 8); assert.equal(root.budget().maxOutputBytes, 20000);
});

test('ready primary can use its own floor behind a blocked head without any release', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units);
  allocation.yield('verify'); allocation.yield('primary');
  const before = root.usage();
  assert.equal(allocation.resume('primary', [request]).reason, 'READER_RESUME_WAITING');
  assert.equal(allocation.resume('primary', [request], { eligibleIds: ['primary'] }).resumed, true);
  assert.deepEqual(root.usage(), before); assert.equal(allocation.summary().releasedUnits, 0);
  assert.equal(allocation.scope('primary').budget().remainingCalls, 2);
  assert.equal(allocation.scope('primary').budget().remainingOutputBytes, 5000);
});

test('scalar readiness uses the same queue filter and does not release blocked floors', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units);
  allocation.yield('verify'); allocation.yield('primary'); allocation.release('peer');
  assert.equal(allocation.resumeBudget('primary').reason, 'READER_RESUME_WAITING');
  assert.equal(allocation.resumeBudget('verify', { eligibleIds: new Set(['primary']) }).attempts, 0);
  const before = root.usage();
  assert.equal(allocation.resumeBudget('primary', { eligibleIds: new Set(['primary']) }).resumed, true);
  assert.deepEqual(root.usage(), before); assert.equal(allocation.scope('primary').budget().remainingCalls, 4);
  assert.equal(allocation.summary().releasedUnits, 1);
});

test('first exact own-floor request resumes without any terminal release and keeps scope identity', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units), scope = allocation.scope('primary');
  allocation.yield('primary'); const before = root.usage(), budget = root.budget();
  assert.equal(allocation.resumeBudget('primary').reason, 'READER_RESUME_WAITING');
  assert.deepEqual(allocation.resume('primary', [request]), { resumed: true, reason: null, attempts: 1 });
  assert.equal(allocation.scope('primary'), scope); assert.deepEqual(root.usage(), before); assert.deepEqual(root.budget(), budget);
  scope.read(request); assert.equal(root.usage().calls, 1); assert.equal(allocation.summary().releasedUnits, 0);
  allocation.yield('primary');
  for (let i = 0; i < 20; i++) assert.deepEqual(allocation.resume('primary', [request]), { resumed: false, reason: 'READER_RESUME_WAITING', attempts: 1 });
});

test('exact cached replay resumes at zero root calls while recharging output only on actual read', () => {
  const root = make({ maxCalls: 1, reuseResults: true });
  const allocation = createReviewReaderAllocation(root, [{ id: 'seed', weight: 1 }, { id: 'primary', weight: 1 }]);
  const result = allocation.scope('seed').read(request); allocation.yield('primary');
  assert.equal(root.budget().remainingCalls, 0); assert.equal(root.preflight([request]).calls, 0);
  const before = root.usage(); assert.equal(allocation.resume('primary', [request], { eligibleIds: ['primary'] }).resumed, true);
  assert.deepEqual(root.usage(), before); assert.deepEqual(allocation.scope('primary').read(request), result);
  assert.equal(root.usage().calls, 1); assert.equal(root.usage().cacheHits, 1);
  assert.equal(root.usage().outputBytes - before.outputBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(root.budget().maxCalls, 1); assert.equal(root.budget().maxOutputBytes, 20000);
});

test('all ready IDs retain FIFO and waiting polls spend neither attempts nor root budget', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units), eligibleIds = ['verify', 'primary'];
  allocation.yield('verify'); allocation.yield('primary'); allocation.release('peer');
  const before = root.usage();
  for (let i = 0; i < 20; i++) assert.deepEqual(allocation.resume('primary', [request], { eligibleIds }), { resumed: false, reason: 'READER_RESUME_WAITING', attempts: 0 });
  assert.equal(allocation.resume('verify', [request], { eligibleIds }).resumed, true);
  assert.equal(allocation.resume('primary', [request], { eligibleIds }).resumed, true);
  assert.deepEqual(root.usage(), before);
});

test('failed actual admissions count once per release revision and readiness changes cannot busy retry', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units), huge = Array.from({ length: 8 }, () => request);
  allocation.yield('verify'); allocation.yield('primary');
  const before = root.usage();
  assert.deepEqual(allocation.resume('primary', huge, { eligibleIds: ['primary'] }), { resumed: false, reason: 'READER_CALL_BUDGET_EXCEEDED', attempts: 1 });
  for (let i = 0; i < 20; i++) {
    assert.equal(allocation.resume('primary', huge, { eligibleIds: [] }).attempts, 1);
    assert.deepEqual(allocation.resume('primary', huge, { eligibleIds: ['primary'] }), { resumed: false, reason: 'READER_RESUME_WAITING', attempts: 1 });
  }
  allocation.release('peer');
  assert.equal(allocation.resume('primary', huge, { eligibleIds: ['primary'] }).attempts, 2);
  allocation.release('future');
  assert.equal(allocation.resume('primary', [request], { eligibleIds: ['primary'] }).reason, 'READER_RESUME_ATTEMPTS_EXHAUSTED');
  assert.deepEqual(root.usage(), before);
});

test('invalid readiness and invalid preflight never spend admission attempts', () => {
  const root = make(), allocation = createReviewReaderAllocation(root, units); allocation.yield('primary');
  for (const eligibleIds of [null, 'primary', ['unknown'], new Set(['unknown'])]) assert.throws(() => allocation.resume('primary', [request], { eligibleIds }), /Invalid reader resume eligibility/);
  assert.throws(() => allocation.resume('primary', [{ ...request, id: 'unknown' }], { eligibleIds: ['primary'] }), /authorized/);
  assert.equal(allocation.resume('primary', [request], { eligibleIds: ['primary'] }).attempts, 1);
  assert.equal(root.usage().calls, 0); assert.equal(root.usage().outputBytes, 0);
});
