import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { prepareMigrationRegression, migrationVerificationPlans } from '../src/migration-regression.mjs';
import { verificationSeeds } from '../src/verification-seeds.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { validateEvidenceReference } from '../src/evidence-reference.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';

function fixture({ padding = 0, duplicates = 1, reader = {}, invalid = false } = {}) {
  const pad = '  shared += 0;\n'.repeat(padding);
  const old = '#include "Entry.h"\n#include "Worker.h"\nvoid Entry::Run(Worker& worker, int value) {\n  if (value < 0) { return; }\n  worker.Run(value);\n' + pad + '}\n';
  const current = '#include "Entry.h"\nvoid Entry::Run(Worker& worker, int value) {\n  shared = value;\n  if (value < 0) { return; }\n' + pad + '}\n';
  const baseline = '#include "Worker.h"\nvoid Worker::Run(int value) {\n  shared = value;\n  if (value < 0) { return; }\n}\n';
  const file = (id, path, left, right) => ({ id, path, eligibility: 'reviewable', properties: [], left: { text: left }, right: { text: right } });
  const headers = [['Entry.h', 'class Entry {\npublic:\n void Run(Worker& worker, int value);\n int shared;\n};\n'], ['Worker.h', 'class Worker {\npublic:\n void Run(int value);\n int shared;\n};\n']];
  const snapshot = { id: 'synthetic-seeds', files: [file('entry', 'Entry.cpp', old, current), file('worker', 'Worker.cpp', baseline, baseline)], context: headers.map(([path, text]) => ({ path, text, oldText: text, oldRevision: 'base', revision: 'target' })), history: { base: 'base', target: 'target' } };
  const contract = buildMigrationContracts(snapshot).contracts.find(c => c.kind === 'old-delegation');
  assert.ok(contract);
  const scope = createRetrievalScope(snapshot, reader), role = contract.new[0];
  const candidates = Array.from({ length: duplicates }, () => ({ fileId: 'entry', anchor: { kind: 'line', side: 'new', start: role.line, end: role.line }, attribution: { status: 'references-validated', editIds: invalid ? ['foreign'] : role.editIds } }));
  const context = prepareMigrationRegression(snapshot, scope, [contract], candidates);
  return { snapshot, contract, scope, candidates, context };
}
function legacy(reader = {}) {
  const file = (id, left, right) => ({ id, path: id + '.js', eligibility: 'reviewable', left: { text: left }, right: { text: right } });
  const snapshot = { id: 'legacy-seeds', context: [], files: [file('A', 'before();\n', 'after();\n'), file('B', 'initial();\n', 'changed();\n'), file('C', 'A();\n', 'A();\n')] };
  const scope = createRetrievalScope(snapshot, reader), source = (id, side) => scope.catalog().find(s => s.fileId === id && s.side === side);
  const role = (id, side) => ({ sourceId: source(id, side).id, fileId: id, path: id + '.js', side, line: 1, symbol: id, editIds: ['e1'] });
  const contract = { id: 'manual', snapshotId: snapshot.id, status: 'navigation-only', causality: 'unverified', candidateFileIds: ['A', 'B'], old: [role('A', 'old')], new: [role('B', 'new')], callers: [{ ...role('C', 'old'), editIds: [], targetFileId: 'A', targetSymbol: 'A' }] };
  const candidates = [{ fileId: 'B', anchor: { kind: 'line', side: 'new', start: 1, end: 1 }, attribution: { status: 'references-validated', editIds: ['e1'] } }];
  return { scope, candidates, snapshot, contract, context: prepareMigrationRegression(snapshot, scope, [contract], candidates) };
}
const seed = (f, options = {}) => verificationSeeds(f.candidates, f.scope, { migrationContext: f.context, fits: () => true, ...options });

test('compiled candidate plans cover complete old/new/baseline and mint fresh receipts', () => {
  const f = fixture(), events = [], resolvers = new Map();
  const result = seed(f, { onReceipt: (id, resolve) => resolvers.set(id, resolve), onMigrationSeeds: e => events.push(e) });
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(x => x.request), migrationVerificationPlans(f.context)[0].requests);
  assert.equal(events[0].status, 'accepted');
  assert.deepEqual(Object.keys(events[0]).sort(), ['candidateId', 'contractId', 'kind', 'status', 'reason', 'rolesCount'].sort());
  for (const item of result) assert.equal(validateEvidenceReference(resolvers.get(item.result.receiptId)({ receiptId: item.result.receiptId }), f.scope.read).status, 'references-validated');
  const fresh = seed(f);
  assert.notEqual(result[0].result.receiptId, fresh[0].result.receiptId);
});

test('copied contexts fail, uncompiled candidates cannot redirect plans and foreign edits fall back', () => {
  const f = fixture();
  assert.throws(() => seed({ ...f, context: structuredClone(f.context) }), /Invalid approved migration/);
  const result = verificationSeeds([{ get anchor() { throw Error('uncompiled getter'); } }], f.scope, { migrationContext: f.context, fits: () => true });
  assert.equal(result.length, 3);
  const bad = fixture({ invalid: true }), events = [];
  assert.equal(seed(bad, { onMigrationSeeds: e => events.push(e) }).length, 1);
  assert.equal(events[0].reason, 'NO_MATCHING_CONTRACT');
});

test('long ranges split at 200 and oversized evidence sets fall back without claiming completeness', () => {
  const f = fixture({ padding: 210 });
  const result = seed(f);
  assert.equal(result.length, 5);
  assert.ok(result.every(x => x.request.count <= 200));
  const huge = fixture({ padding: 850 }), events = [];
  assert.equal(seed(huge, { onMigrationSeeds: e => events.push(e) }).length, 1);
  assert.equal(events[0].status, 'fallback');
  assert.equal(events[0].reason, 'EVIDENCE_LIMIT');
});

test('16KiB cap rolls back a complete role set and duplicate candidates reserve final output bytes upfront', () => {
  const large = fixture({ padding: 500 }), events = [];
  assert.equal(seed(large, { onMigrationSeeds: event => events.push(event) }).length, 1);
  assert.equal(events[0].reason, 'INPUT_CAPACITY');
  const probe = fixture({ duplicates: 2, reader: { reuseResults: true } });
  const requests = migrationVerificationPlans(probe.context)[0].requests;
  const rawBytes = requests.reduce((bytes, request) => bytes + Buffer.byteLength(JSON.stringify(probe.scope.read(request))), 0);
  const results = seed(probe), decoratedBytes = results.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.result)), 0);
  // Enough for raw cache + seed + one candidate final refs, but not two.
  const f = fixture({ duplicates: 2, reader: { reuseResults: true, maxOutputBytes: rawBytes + decoratedBytes * 2 + 1 } }), rejected = [];
  for (const request of migrationVerificationPlans(f.context)[0].requests) f.scope.read(request);
  seed(f, { onMigrationSeeds: event => rejected.push(event) });
  assert.equal(rejected[0].status, 'fallback');
  assert.equal(rejected.some(event => event.status === 'accepted'), false);
});

test('atomic fit failure rolls back entire role set and publishes only ordinary receipt', () => {
  const f = fixture(), resolvers = new Map(), events = [];
  const result = seed(f, { fits: items => items.length === 1, onReceipt: (id, resolve) => resolvers.set(id, resolve), onMigrationSeeds: e => events.push(e) });
  assert.equal(result.length, 1); assert.equal(resolvers.size, 1);
  assert.equal(f.scope.usage().calls, 1); assert.equal(events[0].status, 'fallback');
});

test('final calls reserve all evidence and cancellation rolls back without resolver', () => {
  const low = fixture({ reader: { maxCalls: 5 } }), events = [];
  assert.equal(seed(low, { onMigrationSeeds: e => events.push(e) }).length, 1);
  assert.equal(events[0].status, 'fallback'); assert.equal(low.scope.usage().calls, 1);
  const f = fixture(); let published = 0;
  assert.throws(() => seed(f, { onReceipt: () => published++, signal: { throwIfAborted() { if (f.scope.usage().calls) throw Error('cancelled'); } } }), /cancelled/);
  assert.equal(published, 0); assert.deepEqual(f.scope.usage(), { calls: 0, outputBytes: 0 });
});

test('legacy ranges are explicitly incomplete and EOF cached requests reserve actual-count keys', () => {
  const f = legacy({ reuseResults: true, maxCalls: 1 }), events = [];
  const source = f.scope.catalog().find(s => s.fileId === 'B' && s.side === 'new');
  f.scope.read({ id: source.id, start: 1, count: 5 });
  assert.deepEqual(seed(f, { onMigrationSeeds: e => events.push(e) }), []);
  assert.equal(events[0].reason, 'INCOMPLETE_ROLE_RANGE');
  const available = legacy();
  assert.equal(seed(available).length, 1);
});

test('incomplete reader delivery rolls back every role and exposes no discarded receipt', () => {
  const f = fixture(), original = f.scope, events = [], published = [];
  let reads = 0;
  f.scope = { ...original, read: (request, decorate) => original.read(request, result => decorate(++reads === 2 ? { ...result, count: result.count - 1 } : result)) };
  const result = seed(f, { onReceipt: id => published.push(id), onMigrationSeeds: e => events.push(e) });
  assert.equal(result.length, 1); assert.equal(published.length, 1);
  assert.equal(original.usage().calls, 1); assert.equal(events[0].reason, 'INCOMPLETE_READ');
});

test('verificationLoop forwards source-free diagnostic callback through options', async () => {
  const f = fixture(), events = [];
  const model = async request => {
    const input = JSON.parse(request.input);
    assert.equal(input.retrieved.length, 3);
    return { verdicts: [{ candidateId: 'c1', verdict: 'refuted', reason: 'synthetic refutation', evidence: [{ receiptId: input.retrieved[0].result.receiptId }] }] };
  };
  await verificationLoop(model, { input: JSON.stringify({ snapshotId: f.snapshot.id }), instructions: '' }, f.candidates, f.scope, { enableMigrationRegression: true, migrationSnapshot: f.snapshot, migrationContracts: [f.contract], onMigrationSeeds: e => events.push(e) });
  assert.equal(events[0].status, 'accepted');
});

test('later complete roles cannot under-reserve a prior duplicate candidate fallback', () => {
  const f = fixture({ duplicates: 2, reader: { maxCalls: 8 } }), events = [];
  const result = seed(f, { onMigrationSeeds: event => events.push(event) });
  assert.equal(events.some(event => event.status === 'accepted'), false);
  assert.equal(result.length, 1);
  // Both candidates can still validate the ordinary fallback without borrowing
  // a later complete set whose final rereads cannot fit this shared ledger.
  for (let i = 0; i < 2; i++) {
    const r = result[0].result;
    f.scope.read({ id: r.sourceId, start: r.start, count: r.count });
  }
  assert.ok(f.scope.budget().remainingCalls >= 0);
});

test('cached exact role reads at zero calls remain fresh and duplicate candidate final bytes are reserved', () => {
  const f = fixture({ duplicates: 2, reader: { reuseResults: true, maxCalls: 3 } });
  for (const request of migrationVerificationPlans(f.context)[0].requests) f.scope.read(request);
  const result = seed(f);
  assert.equal(result.length, 3); assert.equal(f.scope.budget().remainingCalls, 0);
  for (let i = 0; i < 2; i++) for (const { result: r } of result) f.scope.read({ id: r.sourceId, start: r.start, count: r.count });
});
