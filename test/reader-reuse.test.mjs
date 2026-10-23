import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { executeRetrievalBatch } from '../src/retrieval-protocol.mjs';
const entries = [{ id: 'old', path: 'a.js', side: 'old', text: 'old needle\nsecond\n' }, { id: 'new', path: 'a.js', side: 'new', text: 'new needle\nsecond\n' }];
const read = { kind: 'read', id: 'new', start: 1, count: 1 };
const make = options => createSnapshotReader('s', entries, { reuseResults: true, ...options });

test('opt-in cache replays exact source/range and charges every delivery without exposing mutable cache', () => {
  const r = make({ maxCalls: 1 });
  const first = r.read(read), bytes = r.usage().outputBytes;
  first.text = 'mutated';
  const second = r.read(read);
  assert.equal(second.text, 'new needle\n');
  assert.deepEqual(r.usage(), { calls: 1, outputBytes: bytes * 2, cacheHits: 1, deliveries: 2, cacheEntries: 1, cacheBytes: bytes });
  assert.equal(r.budget().remainingCalls, 0);
  assert.equal(r.budget().reusableResults, true);
  assert.equal(r.canServe([read]), true);
  assert.equal(r.canServe([{ ...read, id: 'old' }]), false);
  assert.throws(() => r.read({ ...read, start: 2 }), /call budget/);
  const other = createSnapshotReader('other', [{ ...entries[1], text: 'different' }], { reuseResults: true, maxCalls: 1 });
  assert.equal(other.read(read).text, 'different');
  assert.equal(other.usage().cacheHits, 0);
});

test('canonical search filters and default limit share cache but malformed equivalent requests never hit', () => {
  const r = make();
  const first = r.search({ query: 'needle', sourceIds: ['new', 'old'] });
  first.matches[0].line = 999;
  assert.equal(r.search({ query: 'needle', limit: 20, sourceIds: ['old', 'new'] }).matches[0].line, 1);
  assert.equal(r.usage().calls, 1);
  assert.equal(r.usage().cacheHits, 1);
  r.find({ query: 'a.js' }); r.find({ query: 'a.js', limit: 20 });
  assert.equal(r.usage().calls, 2);
  assert.throws(() => r.find({ query: 'a.js', limit: null }), /query/);
  assert.throws(() => r.search({ query: 'needle', sourceIds: ['old', 'old'] }), /filter/);
  assert.throws(() => r.read({ ...read, id: 'missing' }), /authorized/);
  assert.equal(r.usage().cacheHits, 2);
});

test('decorated cached reads always get fresh receipts measured as new output, never cached receipt identity', () => {
  const r = make({ maxCalls: 1 });
  const firstReceipts = createEvidenceReceipts(r.read), secondReceipts = createEvidenceReceipts(r.read);
  const a = firstReceipts.read(read), b = secondReceipts.read(read);
  assert.notEqual(a.receiptId, b.receiptId);
  assert.equal(r.usage().calls, 1);
  assert.equal(r.usage().cacheHits, 1);
  assert.equal(r.usage().outputBytes, Buffer.byteLength(JSON.stringify(a)) + Buffer.byteLength(JSON.stringify(b)));
  assert.throws(() => secondReceipts.resolve({ receiptId: a.receiptId }), /Invalid evidence receipt/);
  assert.equal(r.read(read).receiptId, undefined);
  assert.equal(secondReceipts.resolve({ receiptId: b.receiptId }).text, b.text);
});

test('preflight simulates duplicate batch cache and commits neither ledger nor future cache', () => {
  const r = make({ maxCalls: 1 });
  const before = r.usage();
  const cost = r.preflight([read, read]);
  assert.equal(cost.calls, 1); assert.equal(cost.cacheHits, 1);
  assert.deepEqual(r.usage(), before);
  executeRetrievalBatch({ requests: [read, read] }, { ...r, catalog: () => [{ id: 'new', lineCount: 2 }] });
  assert.equal(r.usage().calls, 1);
  assert.equal(r.usage().cacheHits, 1);
  assert.equal(r.usage().outputBytes, cost.outputBytes);
});

test('transaction failure restores raw cache, call bytes hits and deliveries; cache never survives rollback', () => {
  const r = make({ maxCalls: 2 });
  const before = r.usage();
  assert.throws(() => r.transaction(() => { r.read(read); r.read(read); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(r.usage(), before);
  assert.equal(r.budget().reusableResults, false);
  r.read(read);
  assert.equal(r.usage().calls, 1);
  const after = r.usage();
  assert.throws(() => r.transaction(() => r.read(read, value => ({ ...value, huge: 'x'.repeat(65536) }))), /output budget/);
  assert.deepEqual(r.usage(), after);
});

test('cached output still exhausts finite bytes and cancellation vetoes replay', () => {
  const probe = make(); const size = Buffer.byteLength(JSON.stringify(probe.read(read)));
  const r = make({ maxCalls: 1, maxOutputBytes: size * 2 });
  r.read(read); r.read(read);
  assert.throws(() => r.read(read), /output budget/);
  assert.equal(r.usage().calls, 1); assert.equal(r.usage().cacheHits, 1);
  const controller = new AbortController(), cancelled = make({ signal: controller.signal });
  cancelled.read(read); const before = cancelled.usage(); controller.abort(new Error('stop'));
  assert.throws(() => cancelled.read(read), /stop/);
  assert.deepEqual(cancelled.usage(), before);
});

test('legacy default remains charged per read with unchanged usage and malformed reuse options reject', () => {
  const r = createSnapshotReader('s', entries, { maxCalls: 1 }); r.read(read);
  assert.throws(() => r.read(read), /call budget/);
  assert.deepEqual(Object.keys(r.usage()), ['calls', 'outputBytes']);
  assert.equal(r.budget().reusableResults, undefined);
  assert.throws(() => make({ reuseResults: 1 }), /reuse/);
});
