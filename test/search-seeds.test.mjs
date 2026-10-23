import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSeeds } from '../src/search-seeds.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { hash } from '../src/content.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
const text = prefix => Array.from({ length: 60 }, (_, i) => prefix + i + '\r\n').join('');
function fixture(options = {}, history = false) {
  const snapshot = { id: 'snap', files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', left: { text: text('OLD') }, right: { text: text('NEW') } }], context: [{ path: 'dep.js', text: text('CURRENT'), ...(history ? { revision: 'target', oldRevision: 'base', oldText: text('BEFORE') } : {}) }], ...(history ? { history: { base: 'base', target: 'target' } } : {}) };
  const scope = createRetrievalScope(snapshot, options);
  const request = { instructions: 'review', input: JSON.stringify({ snapshotId: snapshot.id, file: { id: 'f', path: 'a.js' }, context: [] }) };
  const search = (id = 's3', query = 'CURRENT20') => { const operation = { kind: 'search', query, sourceIds: [id], limit: 100 }; return { request: operation, result: scope.search(operation) }; };
  return { snapshot, scope, request, search };
}
const call = f => searchSeeds(f.scope, f.request, [f.search()]);

test('approved exact hit returns fresh CRLF body at original coordinates and no receipt or audit', () => {
  const f = fixture(), record = f.search(); const before = f.scope.usage().calls;
  const result = searchSeeds(f.scope, f.request, [record]);
  assert.equal(result.attempts, 1); assert.equal(result.seeds.length, 1);
  const item = result.seeds[0];
  assert.deepEqual(item.request, { kind: 'read', id: 's3', start: 18, count: 24 });
  assert.equal(item.result.text, text('CURRENT').split('\r\n').slice(17, 41).join('\r\n') + '\r\n');
  assert.equal(item.result.hash, hash(text('CURRENT')));
  assert.equal(item.result.receiptId, undefined);
  assert.equal(f.scope.usage().calls, before + 1);
});

test('old/new historical sources never substitute each other, EOF count is actual', () => {
  const f = fixture({}, true);
  const result = searchSeeds(f.scope, f.request, [f.search('s1', 'OLD59'), f.search('s4', 'BEFORE20')]);
  assert.deepEqual(result.seeds.map(item => item.result.sourceId), ['s1', 's4']);
  assert.equal(result.seeds[0].result.count, 4);
  assert.equal(result.seeds[0].result.text, 'OLD56\r\nOLD57\r\nOLD58\r\nOLD59\r\n');
  assert.ok(result.seeds.every(item => !item.result.text.includes('NEW')));
});

test('only model-requested search records with current snapshot and known source/hash/line qualify', () => {
  for (const change of [
    r => { r.request.kind = 'find'; }, r => { r.result.snapshotId = 'foreign'; },
    r => { r.result.matches[0].sourceId = 'foreign'; }, r => { r.result.matches[0].line = '21'; },
    r => { r.result.matches[0].line = 1000; }, r => { r.result.matches[0].hash = 'not-a-hash'; },
    r => { r.request.sourceIds = ['s2']; }, r => { r.result.matches = Array(101).fill(r.result.matches[0]); },
  ]) {
    const f = fixture(), record = f.search(); change(record); const before = f.scope.usage();
    assert.deepEqual(searchSeeds(f.scope, f.request, [record]), { seeds: [], attempts: 0 });
    assert.deepEqual(f.scope.usage(), before);
  }
  const f = fixture(), r = f.search(); f.request.input = '{}';
  assert.deepEqual(searchSeeds(f.scope, f.request, [r]), { seeds: [], attempts: 0 });
});

test('stale search hash and read snapshot mismatch roll back without publishing body', () => {
  const f = fixture(), record = f.search(); record.result.matches[0].hash = 'a'.repeat(64); const before = f.scope.usage();
  assert.deepEqual(searchSeeds(f.scope, f.request, [record]), { seeds: [], attempts: 1 });
  assert.deepEqual(f.scope.usage(), before);
  const g = fixture(), r = g.search(), baseline = g.scope.usage();
  const scope = { ...g.scope, read(operation) { return { ...g.scope.read(operation), snapshotId: 'other' }; } };
  assert.deepEqual(searchSeeds(scope, g.request, [r]), { seeds: [], attempts: 1 });
  assert.deepEqual(g.scope.usage(), baseline);
});

test('provided full bodies skip only matching source sides and identity windows skip only their coordinates', () => {
  const scenarios = [
    { extra: { file: { id: 'f', path: 'a.js', left: { text: text('OLD') } } }, id: 's1', query: 'OLD20' },
    { extra: { relatedFiles: [{ id: 'f', path: 'a.js', right: { text: text('NEW') } }] }, id: 's2', query: 'NEW20' },
    { extra: { context: [{ path: 'dep.js', text: text('CURRENT') }] }, id: 's3', query: 'CURRENT20' },
    { extra: { sourceMode: 'change-windows', windows: [{ old: { start: 21, count: 1, text: 'OLD20\r\n' }, new: { start: 40, count: 1, text: 'NEW39\r\n' } }] }, id: 's1', query: 'OLD20' },
  ];
  for (const scenario of scenarios) {
    const f = fixture(); f.request.input = JSON.stringify({ ...JSON.parse(f.request.input), ...scenario.extra });
    const before = f.scope.usage().calls; const result = searchSeeds(f.scope, f.request, [f.search(scenario.id, scenario.query)]);
    assert.equal(result.attempts, 0); assert.equal(f.scope.usage().calls, before + 1);
  }
  const f = fixture(); f.request.input = JSON.stringify({ ...JSON.parse(f.request.input), sourceMode: 'change-windows', windows: [{ old: { start: 21, count: 1, text: 'OLD20' }, new: { start: 40, count: 1, text: 'NEW39' } }] });
  assert.equal(searchSeeds(f.scope, f.request, [f.search('s2', 'NEW20')]).seeds.length, 1);
  const h = fixture({}, true); h.request.input = JSON.stringify({ ...JSON.parse(h.request.input), context: [{ path: 'dep.js', text: text('CURRENT') }] });
  assert.equal(searchSeeds(h.scope, h.request, [h.search('s4', 'BEFORE20')]).seeds.length, 1);
});

test('already retrieved matching ranges dedupe; mismatched snapshot/hash cannot suppress exact read', () => {
  const f = fixture(), record = f.search();
  const existing = [{ request: { kind: 'read', id: 's3', start: 20, count: 3 }, result: f.scope.read({ id: 's3', start: 20, count: 3 }) }];
  assert.deepEqual(searchSeeds(f.scope, f.request, [record], { existing }), { seeds: [], attempts: 0 });
  existing[0].result.hash = 'b'.repeat(64);
  assert.equal(searchSeeds(f.scope, f.request, [record], { existing }).seeds.length, 1);
});

test('stable unique hits cap both successful and rolled-back attempts at two', () => {
  const f = fixture(); const records = [f.search('s3', 'CURRENT')];
  const result = searchSeeds(f.scope, f.request, records);
  assert.equal(result.attempts, 2); assert.equal(result.seeds.length, 2);
  assert.deepEqual(result.seeds.map(item => item.request.start), [1, 22]);
  const g = fixture(), r = g.search('s3', 'CURRENT'), before = g.scope.usage();
  const failed = searchSeeds(g.scope, g.request, [r], { maxInputBytes: 1 });
  assert.deepEqual(failed, { seeds: [], attempts: 2 });
  assert.deepEqual(g.scope.usage(), before);
  assert.deepEqual(searchSeeds(g.scope, g.request, [r], { maxReads: 0 }), { seeds: [], attempts: 0 });
  assert.equal(searchSeeds(g.scope, g.request, [r], { maxReads: 1 }).attempts, 1);
});

test('full request bytes including builder metadata fit transactionally; no leftover calls/output', () => {
  const f = fixture(), record = f.search(), baseline = f.scope.usage();
  let builderRecords;
  const result = searchSeeds(f.scope, f.request, [record], { maxInputBytes: 500, buildRequest(records) { builderRecords = records; return { instructions: 'x'.repeat(300), input: 'é'.repeat(101) }; } });
  assert.deepEqual(result, { seeds: [], attempts: 1 });
  assert.equal(builderRecords.length, 1);
  assert.deepEqual(f.scope.usage(), baseline);
  const g = fixture(), r = g.search();
  assert.equal(searchSeeds(g.scope, g.request, [r], { maxInputBytes: 502, buildRequest: () => ({ instructions: 'x'.repeat(300), input: 'é'.repeat(101) }) }).seeds.length, 1);
});

test('leave four shared calls plus16KiB output; failed output budget read rolls back', () => {
  const f = fixture({ maxCalls: 5 }), record = f.search();
  assert.deepEqual(searchSeeds(f.scope, f.request, [record]), { seeds: [], attempts: 0 });
  const g = fixture({ maxCalls: 6 }), r = g.search();
  assert.equal(searchSeeds(g.scope, g.request, [r]).seeds.length, 1);
  assert.equal(g.scope.budget().remainingCalls, 4);
  const h = fixture({ maxOutputBytes: 16500 });
  // Supply a host search result directly so the test isolates optional read reserve.
  const records = [{ request: { kind: 'search', query: 'CURRENT20' }, result: { snapshotId: 'snap', matches: [{ sourceId: 's3', line: 21, hash: hash(text('CURRENT')) }] } }];
  assert.deepEqual(searchSeeds(h.scope, h.request, records), { seeds: [], attempts: 1 });
  assert.deepEqual(h.scope.usage(), { calls: 0, outputBytes: 0 });
});

test('remaining loop allowance tracks failed attempts and successful deduplication across calls', () => {
  const f = fixture(), record = f.search('s3', 'CURRENT');
  const first = searchSeeds(f.scope, f.request, [record], { maxReads: 1 });
  const second = searchSeeds(f.scope, f.request, [record], { maxReads: 2 - first.attempts, existing: first.seeds });
  assert.equal(first.attempts + second.attempts, 2);
  assert.deepEqual([...first.seeds, ...second.seeds].map(item => item.request.start), [1, 22]);
  assert.deepEqual(searchSeeds(f.scope, f.request, [record], { maxReads: 2 - first.attempts - second.attempts }), { seeds: [], attempts: 0 });
});

test('large single-line optional output rolls back and mints no cross-phase evidence receipts', () => {
  const body = 'TARGET' + 'x'.repeat(65000);
  const snapshot = { id: 'large', files: [], context: [{ path: 'big.js', text: body }] };
  const scope = createRetrievalScope(snapshot);
  const request = { instructions: 'review', input: JSON.stringify({ snapshotId: 'large', context: [] }) };
  const operation = { kind: 'search', query: 'TARGET', sourceIds: ['s1'] };
  const record = { request: operation, result: scope.search(operation) }, before = scope.usage();
  let decorators = 0;
  const raw = { ...scope, read(operation, decorate) { if (decorate) decorators++; return scope.read(operation, decorate); } };
  assert.deepEqual(searchSeeds(raw, request, [record], { maxInputBytes: 1000 }), { seeds: [], attempts: 1 });
  assert.deepEqual(scope.usage(), before);
  assert.equal(decorators, 0);
  const receipts = createEvidenceReceipts(scope.read);
  assert.throws(() => receipts.resolve({ receiptId: 'foreign-search-phase' }), /Invalid evidence receipt/);
});

test('catalog hash when present rejects stale hits before read; foreign read IDs roll back', () => {
  const f = fixture(), record = f.search(), before = f.scope.usage();
  const catalog = f.scope.catalog().map(item => ({ ...item, hash: 'a'.repeat(64) }));
  assert.deepEqual(searchSeeds({ ...f.scope, catalog: () => catalog }, f.request, [record]), { seeds: [], attempts: 0 });
  assert.deepEqual(f.scope.usage(), before);
  const foreign = { ...f.scope, read(operation) { return { ...f.scope.read(operation), sourceId: 's2' }; } };
  assert.deepEqual(searchSeeds(foreign, f.request, [record]), { seeds: [], attempts: 1 });
  assert.deepEqual(f.scope.usage(), before);
});

test('strict options, cancellation and authorization failures remain fail-closed', () => {
  for (const maxReads of [-1, 3, '2', 1.5]) assert.throws(() => searchSeeds(fixture().scope, fixture().request, [], { maxReads }), /Invalid search seed options/);
  for (const maxInputBytes of [0, '100', NaN]) assert.throws(() => searchSeeds(fixture().scope, fixture().request, [], { maxInputBytes }), /Invalid search seed options/);
  const controller = new AbortController(); controller.abort(Error('cancelled')); const f = fixture();
  assert.throws(() => searchSeeds(f.scope, f.request, [], { signal: controller.signal }), /cancelled/);
  const g = fixture(), record = g.search(), baseline = g.scope.usage(), during = new AbortController();
  const scope = { ...g.scope, read(operation) { const result = g.scope.read(operation); during.abort(Error('mid read')); return result; } };
  assert.throws(() => searchSeeds(scope, g.request, [record], { signal: during.signal }), /mid read/);
  assert.deepEqual(g.scope.usage(), baseline);
  assert.throws(() => searchSeeds({ ...g.scope, read() { throw Error('authorization changed'); } }, g.request, [record]), /authorization changed/);
  assert.throws(() => searchSeeds(g.scope, g.request, [record], { buildRequest: () => ({}) }), /Invalid search seed request builder/);
});
