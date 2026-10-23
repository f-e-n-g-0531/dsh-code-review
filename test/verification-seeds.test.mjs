import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationSeeds } from '../src/verification-seeds.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';

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

test('hard reader errors propagate rather than being hidden as optional capacity failures', () => {
  const { scope } = setup();
  assert.throws(() => seed([candidate()], { ...scope, read() { throw Error('approval revoked'); } }), /approval revoked/);
});
