import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationSeeds } from '../src/verification-seeds.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { validateEvidenceReference } from '../src/evidence-reference.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createReviewReaderAllocation } from '../src/review-reader-allocation.mjs';

const candidate = (side = 'new', start = 1, end = start) => ({ fileId: 'f1', anchor: { kind: 'line', side, start, end, snippet: 'untrusted prose' } });
function setup(text = 'actual();\r\n', options = {}) {
  const reader = createSnapshotReader('snap', [{ id: 'old', text: 'old();\n' }, { id: 'new', text }], options);
  const scope = { ...reader, catalog: () => [{ id: 'old', fileId: 'f1', side: 'old' }, { id: 'new', fileId: 'f1', side: 'new' }] };
  return { reader, scope };
}
const seed = (candidates, scope, options = {}) => verificationSeeds(candidates, scope, { fits: () => true, ...options });

test('seeds deduplicate exact ranges and preserve CRLF, EOF and source side', () => {
  const { reader, scope } = setup();
  const resolvers = new Map();
  const results = seed([candidate(), candidate(), candidate('old')], scope, { onReceipt: (id, resolve) => resolvers.set(id, resolve) });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.result.sourceId), ['new', 'old']);
  assert.equal(results[0].result.text, 'actual();\r\n');
  assert.equal(results[0].result.count, 1);
  assert.equal(results[0].result.endOfSource, true);
  assert.equal(resolvers.get(results[0].result.receiptId)({ receiptId: results[0].result.receiptId }).text, 'actual();\r\n');
  assert.equal(reader.usage().calls, 2);
});

test('only real line coordinates and unique catalog fileId+side authorize seeds', () => {
  const { reader, scope } = setup();
  for (const value of [{}, { fileId: 'f1', anchor: { kind: 'file' } }, { ...candidate(), fileId: 'foreign' }, { ...candidate(), fileId: undefined }, candidate('context'), candidate('new', '1'), candidate('new', 0), candidate('new', 2, 1), candidate('new', 2), candidate('new', 1000)]) {
    assert.deepEqual(seed([value], scope), []);
  }
  assert.deepEqual(seed([candidate()], { ...scope, catalog: () => [{ id: 'new', side: 'new' }] }), []);
  assert.deepEqual(seed([candidate()], { ...scope, catalog: () => [...scope.catalog(), { id: 'other', fileId: 'f1', side: 'new' }] }), []);
  assert.deepEqual(seed([candidate()], { ...scope, transaction: undefined }), []);
  assert.equal(reader.usage().calls, 0);
});

test('seeds are capped at eight reads of at most 200 lines and do not assume opposite mappings', () => {
  const text = Array.from({ length: 400 }, (_, i) => i + '\n').join('');
  const { reader, scope } = setup(text);
  const results = seed(Array.from({ length: 20 }, (_, i) => candidate('new', 10 + i * 10, 399)), scope);
  assert.equal(results.length, 8);
  assert.ok(results.every(item => item.request.id === 'new' && item.request.count <= 200));
  assert.equal(reader.usage().calls, 8);
});

test('rolled-back seeds publish no receipt resolvers and later seeds remain usable', () => {
  const { reader, scope } = setup();
  const resolvers = new Map(); let attempts = 0;
  const results = seed([candidate(), candidate('old')], scope, {
    fits: () => ++attempts > 1,
    onReceipt: (id, resolve) => resolvers.set(id, resolve),
  });
  assert.equal(results.length, 1);
  assert.equal(resolvers.size, 1);
  assert.equal(results[0].result.sourceId, 'old');
  assert.equal(reader.usage().calls, 1);
  assert.equal(resolvers.get(results[0].result.receiptId)({ receiptId: results[0].result.receiptId }).text, 'old();\n');
});

test('optional overflow and output budgets roll back and leave ordinary retrieval possible', () => {
  for (const options of [{}, { maxOutputBytes: 200 }, { maxOutputBytes: 400 }]) {
    const { reader, scope } = setup('actual();\n', options);
    assert.deepEqual(seed([candidate()], scope, { fits: () => false }), []);
    assert.deepEqual(reader.usage(), { calls: 0, outputBytes: 0 });
    assert.equal(reader.read({ id: 'new', start: 1, count: 1 }).text, 'actual();\n');
  }
  const { reader, scope } = setup('x'.repeat(17000));
  assert.deepEqual(seed([candidate()], scope), []);
  assert.deepEqual(reader.usage(), { calls: 0, outputBytes: 0 });
});

test('seeds preserve final evidence calls and byte reserve, shared exhaustion and cancellation', () => {
  const low = setup('actual();\n', { maxCalls: 1 });
  assert.deepEqual(seed([candidate()], low.scope), []);
  assert.equal(low.reader.usage().calls, 0);
  low.reader.read({ id: 'new', start: 1, count: 1 });
  assert.deepEqual(seed([candidate()], low.scope), []);
  const bytes = setup('actual();\n', { maxOutputBytes: 400 });
  assert.deepEqual(seed([candidate()], bytes.scope), []);
  assert.equal(bytes.reader.usage().calls, 0);
  const controller = new AbortController();
  controller.abort(Error('cancelled'));
  assert.throws(() => seed([candidate()], low.scope, { signal: controller.signal }), /cancelled/);
  const cancelled = setup();
  assert.throws(() => seed([candidate()], cancelled.scope, { signal: { throwIfAborted() { if (cancelled.reader.usage().calls) throw Error('cancel during prefetch'); } } }), /cancel during prefetch/);
  assert.deepEqual(cancelled.reader.usage(), { calls: 0, outputBytes: 0 });
});

test('exact raw cache at zero calls mints fresh verification receipts and revalidates original bytes', () => {
  const text = 'actual();\r\n'.repeat(20), { reader, scope } = setup(text, { reuseResults: true, maxCalls: 1 });
  const operation = { kind: 'read', id: 'new', start: 1, count: 5 };
  const prior = createEvidenceReceipts(scope.read).read(operation);
  const before = reader.usage(), resolvers = new Map();
  assert.equal(reader.budget().remainingCalls, 0);
  const seeds = seed([candidate()], scope, { onReceipt: (id, resolve) => resolvers.set(id, resolve) });
  assert.equal(seeds.length, 1); assert.notEqual(seeds[0].result.receiptId, prior.receiptId);
  assert.equal(seeds[0].result.text, 'actual();\r\n'.repeat(5));
  assert.throws(() => resolvers.get(seeds[0].result.receiptId)({ receiptId: prior.receiptId }), /Invalid evidence receipt/);
  const evidence = resolvers.get(seeds[0].result.receiptId)({ receiptId: seeds[0].result.receiptId });
  assert.equal(validateEvidenceReference(evidence, scope.read).status, 'references-validated');
  assert.equal(reader.usage().calls, before.calls); assert.equal(reader.usage().cacheHits, before.cacheHits + 2);
  assert.ok(reader.usage().outputBytes > before.outputBytes);
});

test('same-side cache miss and different EOF actual-count cache key cannot bypass final call reserve', () => {
  const cases = [
    { text: 'actual();\n'.repeat(20), warm: { kind: 'read', id: 'old', start: 1, count: 5 } },
    { text: 'actual();\n'.repeat(20), warm: { kind: 'read', id: 'new', start: 2, count: 5 } },
    { text: 'actual();\n', warm: { kind: 'read', id: 'new', start: 1, count: 5 } },
  ];
  for (const { text, warm } of cases) {
    const { reader, scope } = setup(text, { reuseResults: true, maxCalls: 1 }); reader.read(warm);
    const before = reader.usage(), published = [];
    assert.deepEqual(seed([candidate()], scope, { onReceipt: (...args) => published.push(args) }), []);
    assert.deepEqual(reader.usage(), before); assert.equal(published.length, 0);
  }
});

test('EOF cached seed succeeds only if exact actual-count validation read is independently cached', () => {
  const { reader, scope } = setup('actual();\r\n', { reuseResults: true, maxCalls: 2 });
  reader.read({ id: 'new', start: 1, count: 5 }); reader.read({ id: 'new', start: 1, count: 1 });
  const before = reader.usage(), resolvers = new Map();
  const seeds = seed([candidate()], scope, { onReceipt: (id, resolve) => resolvers.set(id, resolve) });
  assert.equal(seeds.length, 1); assert.equal(seeds[0].result.count, 1);
  const evidence = resolvers.get(seeds[0].result.receiptId)({ receiptId: seeds[0].result.receiptId });
  validateEvidenceReference(evidence, scope.read); assert.equal(reader.usage().calls, before.calls);
});

test('cached receipt bytes and final-read headroom remain bounded with no partial receipts on overflow or cancellation', () => {
  for (const maxOutputBytes of [190, 420, 530]) {
    const { reader, scope } = setup('x\n'.repeat(20), { reuseResults: true, maxCalls: 1, maxOutputBytes });
    reader.read({ id: 'new', start: 1, count: 5 }); const before = reader.usage(), published = [];
    assert.deepEqual(seed([candidate()], scope, { onReceipt: (...args) => published.push(args) }), []);
    assert.deepEqual(reader.usage(), before); assert.equal(published.length, 0);
  }
  const { reader, scope } = setup('actual();\n'.repeat(20), { reuseResults: true, maxCalls: 1 });
  reader.read({ id: 'new', start: 1, count: 5 }); const before = reader.usage(), published = [];
  assert.throws(() => seed([candidate()], scope, { signal: { throwIfAborted() { if (reader.usage().cacheHits > before.cacheHits) throw Error('cancel cached receipt'); } }, onReceipt: (...args) => published.push(args) }), /cancel cached receipt/);
  assert.deepEqual(reader.usage(), before); assert.equal(published.length, 0);
  assert.deepEqual(seed([candidate()], scope, { fits: () => false }), []); assert.deepEqual(reader.usage(), before);
});

test('zero-call allocated verification cache still charges fresh bytes and keeps repeated final references usable', () => {
  const { reader, scope: root } = setup('actual();\n'.repeat(20), { reuseResults: true, maxCalls: 1 });
  root.read({ id: 'new', start: 1, count: 5 });
  const allocation = createReviewReaderAllocation(root, [{ id: 'verification', weight: 1 }, { id: 'later', weight: 1 }]), scope = allocation.scope('verification');
  const before = reader.usage(), resolvers = new Map();
  const seeds = seed([candidate(), candidate()], scope, { onReceipt: (id, resolve) => resolvers.set(id, resolve) });
  assert.equal(seeds.length, 1);
  for (let i = 0; i < 2; i++) validateEvidenceReference(resolvers.get(seeds[0].result.receiptId)({ receiptId: seeds[0].result.receiptId }), scope.read);
  assert.equal(reader.usage().calls, before.calls); assert.equal(reader.usage().cacheHits, before.cacheHits + 3);
  assert.ok(scope.usage().outputBytes > 0);
});

test('cached seed with zero output bytes and cancellation during fit publishes no capability', () => {
  const text = 'actual();\n'.repeat(20), operation = { id: 'new', start: 1, count: 5 };
  const bytes = Buffer.byteLength(JSON.stringify(setup(text).reader.read(operation)));
  const empty = setup(text, { reuseResults: true, maxCalls: 1, maxOutputBytes: bytes }); empty.reader.read(operation);
  const before = empty.reader.usage(); assert.equal(empty.reader.budget().remainingOutputBytes, 0);
  assert.deepEqual(seed([candidate()], empty.scope), []); assert.deepEqual(empty.reader.usage(), before);
  const cached = setup(text, { reuseResults: true, maxCalls: 1 }); cached.reader.read(operation);
  const usage = cached.reader.usage(), controller = new AbortController(), published = [];
  assert.throws(() => seed([candidate()], cached.scope, { signal: controller.signal, fits() { controller.abort(Error('cancel during fit')); return true; }, onReceipt: (...args) => published.push(args) }), /cancel during fit/);
  assert.equal(published.length, 0); assert.deepEqual(cached.reader.usage(), usage);
});

test('verification loop accepts cached fresh seed evidence with zero remaining materialization calls', async () => {
  const { reader, scope } = setup('actual();\r\n'.repeat(20), { reuseResults: true, maxCalls: 1 });
  reader.read({ id: 'new', start: 1, count: 5 }); let calls = 0;
  const result = await verificationLoop(async request => {
    calls++; const input = JSON.parse(request.input); assert.equal(input.retrieved.length, 1);
    const evidence = input.retrieved[0].result; assert.ok(evidence.receiptId);
    return { verdicts: [{ candidateId: 'c1', verdict: 'refuted', reason: 'fresh approved counterevidence', evidence: [{ receiptId: evidence.receiptId }], regression: { classification: 'uncertain', reason: 'no baseline comparison', oldEvidence: [], newEvidence: [] } }] };
  }, { instructions: 'review', input: '{}', signal: new AbortController().signal }, [candidate()], scope, { maxRounds: 1 });
  assert.equal(calls, 1); assert.equal(result[0].verdict, 'refuted'); assert.equal(result[0].evidence[0].status, 'references-validated');
  assert.equal(reader.usage().calls, 1); assert.equal(reader.usage().cacheHits, 2);
});

test('hard reader errors propagate rather than being hidden as optional capacity failures', () => {
  const { scope } = setup();
  assert.throws(() => seed([candidate()], { ...scope, read() { throw Error('approval revoked'); } }), /approval revoked/);
});
