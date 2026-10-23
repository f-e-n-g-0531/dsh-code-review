import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createReviewReaderAllocation } from '../src/review-reader-allocation.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
const make = options => createRetrievalScope({ id: 's', context: [], files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', left: { text: 'old\nsecond\nthird\n' }, right: { text: 'new\nsecond\nthird\n' } }] }, { reuseResults: true, ...options });
const read = { kind: 'read', id: 's2', start: 1, count: 1 };

test('74 fixed equal floors stop an early greedy stage and preserve later synthesis and verification units', () => {
  const root = make({ maxCalls: 296, maxOutputBytes: 4 * 1024 * 1024 });
  const units = Array.from({ length: 74 }, (_, i) => ({ id: 'u' + i, weight: 1 }));
  const allocation = createReviewReaderAllocation(root, units), first = allocation.scope('u0');
  assert.equal(first.budget().remainingCalls, 4);
  for (let i = 0; i < 4; i++) first.find({ query: 'query' + i });
  assert.throws(() => first.find({ query: 'greedy' }), /allocation call/);
  assert.equal(root.usage().calls, 4);
  assert.equal(allocation.scope('u73').budget().remainingCalls, 4);
  allocation.scope('u73').read(read);
  assert.equal(root.budget().maxCalls, 296);
  assert.equal(root.budget().maxOutputBytes, 4 * 1024 * 1024);
});

test('weights protect proportional floors; released unused portions become shared without raising root limits', () => {
  const root = make({ maxCalls: 12 });
  const a = createReviewReaderAllocation(root, [{ id: 'primary', weight: 4 }, { id: 'synthesis', weight: 2 }, { id: 'verification', weight: 2 }]);
  assert.equal(a.scope('primary').budget().remainingCalls, 6);
  assert.equal(a.scope('verification').budget().remainingCalls, 3);
  a.release('synthesis'); a.release('synthesis'); a.release('optional-never-planned');
  assert.equal(a.scope('primary').budget().remainingCalls, 9);
  assert.throws(() => a.scope('synthesis'), /unavailable/);
  assert.deepEqual(a.summary(), { units: 3, releasedUnits: 1, calls: 0, outputBytes: 0, cacheHits: 0 });
  assert.equal(root.budget().remainingCalls, 12);
});

test('cached replay is permitted at zero unit/root materialization calls but fresh output is recharged', () => {
  const root = make({ maxCalls: 1 });
  const a = createReviewReaderAllocation(root, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]);
  const first = a.scope('a').read(read); const later = a.scope('b');
  assert.equal(later.budget().remainingCalls, 0);
  assert.equal(later.budget().reusableResults, true);
  assert.equal(later.canServe([read]), true);
  assert.equal(later.preflight([read]).calls, 0);
  assert.deepEqual(later.read(read), first);
  assert.equal(root.usage().calls, 1); assert.equal(root.usage().cacheHits, 1);
  assert.equal(later.usage().outputBytes, Buffer.byteLength(JSON.stringify(first)));
  assert.equal(later.canServe([{ ...read, start: 2 }]), false);
});

test('batch rollback restores unit counters root ledgers and cache if later request fails', () => {
  const root = make({ maxCalls: 6 }), a = createReviewReaderAllocation(root, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]), scope = a.scope('a');
  const before = root.usage(), unit = scope.usage();
  assert.throws(() => scope.transaction(() => { scope.read(read); scope.read(read); scope.read({ ...read, id: 'missing' }); }), /authorized/);
  assert.deepEqual(root.usage(), before); assert.deepEqual(scope.usage(), unit);
  assert.equal(root.budget().reusableResults, false);
  scope.read(read);
  assert.equal(root.usage().calls, 1); assert.equal(scope.usage().calls, 1);
});

test('decorated byte overflow rolls back fair share even when raw preflight fit', () => {
  const root = make({ maxCalls: 4, maxOutputBytes: 600 }), a = createReviewReaderAllocation(root, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]), scope = a.scope('a');
  const before = root.usage();
  assert.throws(() => scope.read(read, value => ({ ...value, extra: 'x'.repeat(200) })), /allocation output/);
  assert.deepEqual(root.usage(), before); assert.equal(scope.usage().calls, 0);
  const one = createEvidenceReceipts(scope.read).read(read);
  assert.ok(one.receiptId); assert.equal(scope.usage().calls, 1);
  assert.equal(a.scope('b').budget().remainingOutputBytes >= 300, true);
});

test('allocation validation and empty plans are bounded source-free and scopes keep immutable catalog authority', () => {
  const root = make();
  for (const units of [null, [{ id: 'same', weight: 1 }, { id: 'same', weight: 1 }], [{ id: 'a', weight: 0 }], [{ id: 'a', weight: NaN }]]) assert.throws(() => createReviewReaderAllocation(root, units), /unit/);
  const a = createReviewReaderAllocation(root, [{ id: 'secret-id', weight: 1 }]), scope = a.scope('secret-id');
  const catalog = scope.catalog(); catalog[0].path = 'forged';
  assert.equal(scope.catalog()[0].path, 'a.js');
  assert.ok(!JSON.stringify(a.summary()).includes('secret-id'));
  assert.deepEqual(createReviewReaderAllocation(root, []).summary(), { units: 0, releasedUnits: 0, calls: 0, outputBytes: 0, cacheHits: 0 });
});
