import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceContext } from '../src/evidence-context.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { createReviewReaderAllocation } from '../src/review-reader-allocation.mjs';
import { retrievalLoop, retrievalRequest } from '../src/retrieval-loop.mjs';
import { configureWireBudget, modelWireBudget } from '../src/model-wire-budget.mjs';
const text = prefix => Array.from({ length: 100 }, (_, i) => prefix + i + '\r\n').join('');
function fixture(options = {}, id = 'snap') {
 const reader = createSnapshotReader(id, [{ id: 'old', text: text('OLD') }, { id: 'new', text: text('NEW') }, { id: 'ctx', text: text('CTX') }, { id: 'ctx-old', text: text('BEFORE') }], options);
 const catalog = [{ id: 'old', fileId: 'f1', path: 'a.js', side: 'old', lineCount: 100 }, { id: 'new', fileId: 'f1', path: 'a.js', side: 'new', lineCount: 100 }, { id: 'ctx', path: 'dep.js', side: 'context', lineCount: 100 }, { id: 'ctx-old', path: 'dep.js', side: 'context-old', lineCount: 100 }];
 return { ...reader, catalog: () => structuredClone(catalog) };
}
const request = (payload = {}, extra = {}) => ({ instructions: 'review', input: JSON.stringify({ snapshotId: 'snap', ...payload }), signal: new AbortController().signal, ...extra });
const audit = result => ({ kind: 'read', snapshotId: result.snapshotId, sourceId: result.sourceId, hash: result.hash, start: result.start, count: result.count });
function warm(scope, context, id = 'old', start = 10, count = 8) { const value = scope.read({ id, start, count }); context.remember([audit(value)]); return value; }

test('context stores only admitted coordinates, deduplicates and never exports body or old receipt', () => {
 const scope = fixture({ reuseResults: true }), context = createEvidenceContext('snap');
 const old = createEvidenceReceipts(scope.read).read({ id: 'old', start: 10, count: 8 });
 context.remember([{ ...audit(old), text: 'forged-body', receiptId: old.receiptId }]); context.remember([audit(old)]);
 assert.equal(context.size(), 1); const before = scope.usage();
 const seeds = context.seed(scope, request(), { sourceIds: ['old'] });
 assert.equal(seeds.length, 1); assert.equal(seeds[0].result.text, text('OLD').split('\r\n').slice(9, 17).join('\r\n') + '\r\n');
 assert.equal(seeds[0].result.receiptId, undefined); assert.equal(scope.usage().calls, before.calls);
 assert.equal(scope.usage().cacheHits, before.cacheHits + 1); assert.ok(scope.usage().outputBytes > before.outputBytes);
 assert.equal(context.size(), 1);
});

test('current-stage reader performs every replay; context without delivery or selection provides no evidence', () => {
 const context = createEvidenceContext('snap'), prior = fixture();
 const read = prior.read({ id: 'old', start: 10, count: 8 });
 assert.deepEqual(context.seed(prior, request(), { sourceIds: ['old'] }), []);
 context.remember([audit(read)]); const current = fixture(); let reads = 0;
 const wrapped = { ...current, read(operation) { reads++; return current.read(operation); } };
 assert.deepEqual(context.seed(wrapped, request()), []); assert.equal(reads, 0);
 const seeds = context.seed(wrapped, request(), { sourceIds: ['old'] });
 assert.equal(seeds.length, 1); assert.equal(reads, 1); assert.equal(current.usage().calls, 1); assert.equal(prior.usage().calls, 1);
});

test('foreign snapshots hashes identities and invalid metadata never promote remembered coordinates into authority', () => {
 const context = createEvidenceContext('snap'), scope = fixture(); const value = warm(scope, context);
 context.remember([{ ...audit(value), snapshotId: 'foreign' }, { ...audit(value), kind: 'search' }, { ...audit(value), omitted: true }, { ...audit(value), count: 0 }, { ...audit(value), count: 201 }, { ...audit(value), hash: 'not-hash' }]);
 assert.equal(context.size(), 1);
 assert.deepEqual(context.seed(scope, request({ snapshotId: 'foreign' }), { sourceIds: ['old'] }), []);
 const foreign = fixture({}, 'foreign'), before = foreign.usage();
 assert.deepEqual(context.seed(foreign, request(), { sourceIds: ['old'] }), []); assert.deepEqual(foreign.usage(), before);
 const stale = { ...scope, read(operation) { return { ...scope.read(operation), hash: 'a'.repeat(64) }; } }, oldUsage = scope.usage();
 assert.deepEqual(context.seed(stale, request(), { sourceIds: ['old'] }), []); assert.deepEqual(scope.usage(), oldUsage);
 const unauthorized = { ...scope, catalog: () => scope.catalog().filter(source => source.id !== 'old') };
 assert.deepEqual(context.seed(unauthorized, request(), { sourceIds: ['old'] }), []);
 assert.deepEqual(context.seed({ ...scope, catalog: () => [...scope.catalog(), scope.catalog()[0]] }, request(), { sourceIds: ['old'] }), []);
});

test('stage target IDs and overlap ranges select exact sides and original coordinates only', () => {
 const scope = fixture(), context = createEvidenceContext('snap'); warm(scope, context, 'old', 10, 12); warm(scope, context, 'new', 30, 9); warm(scope, context, 'ctx-old', 12, 4);
 const result = context.seed(scope, request(), { ranges: [{ sourceId: 'old', start: 15, count: 3 }, { sourceId: 'new', start: 90, count: 2 }], sourceIds: ['ctx-old'] });
 assert.deepEqual(result.map(item => item.request), [{ kind: 'read', id: 'old', start: 15, count: 3 }, { kind: 'read', id: 'ctx-old', start: 12, count: 4 }]);
 assert.ok(result[0].result.text.startsWith('OLD14\r\n')); assert.ok(result[1].result.text.startsWith('BEFORE11\r\n'));
});

test('provided main related grouped bodies context sides exact windows and existing reads suppress only matching evidence', () => {
 const scope = fixture(), context = createEvidenceContext('snap'); warm(scope, context, 'old'); warm(scope, context, 'new'); warm(scope, context, 'ctx'); warm(scope, context, 'ctx-old');
 for (const payload of [{ file: { id: 'f1', path: 'a.js', left: { text: text('OLD') } } }, { relatedFiles: [{ id: 'f1', path: 'a.js', left: { text: text('OLD') } }] }, { sourceMode: 'group-primary', reviews: [{ file: { id: 'f1', path: 'a.js', left: { text: text('OLD') } } }] }, { file: { id: 'f1', path: 'a.js' }, sourceMode: 'change-windows', windows: [{ old: { start: 8, count: 12, text: 'original' } }] }]) {
  assert.equal(context.seed(scope, request(payload), { sourceIds: ['old', 'new'] }).length, 1);
 }
 const contexts = context.seed(scope, request({ context: [{ path: 'dep.js', text: text('CTX') }] }), { sourceIds: ['ctx', 'ctx-old'] });
 assert.deepEqual(contexts.map(item => item.request.id), ['ctx-old']);
 const existing = [{ request: { kind: 'read', id: 'old' }, result: scope.read({ id: 'old', start: 9, count: 20 }) }];
 assert.deepEqual(context.seed(scope, request(), { sourceIds: ['old'], existing }), []);
});

test('bounded FIFO and read/line/byte/attempt caps never send unbounded stored history', () => {
 const context = createEvidenceContext('snap', { maxEntries: 2 }), scope = fixture();
 warm(scope, context, 'old'); warm(scope, context, 'new'); warm(scope, context, 'ctx'); assert.equal(context.size(), 2);
 assert.deepEqual(context.seed(scope, request(), { sourceIds: ['old'] }), []);
 const seeds = context.seed(scope, request(), { sourceIds: ['new', 'ctx'], maxReads: 1, maxLines: 3 });
 assert.equal(seeds.length, 1); assert.equal(seeds[0].request.id, 'new'); assert.equal(seeds[0].request.count, 3);
 let reads = 0; const wrapped = { ...scope, read(operation) { reads++; return scope.read(operation); } }, before = scope.usage();
 assert.deepEqual(context.seed(wrapped, request(), { sourceIds: ['new', 'ctx'], maxReads: 1, maxBytes: 1 }), []);
 assert.equal(reads, 1); assert.deepEqual(scope.usage(), before);
 assert.deepEqual(context.seed(scope, request(), { sourceIds: ['new'], maxReads: 0 }), []);
});

test('full combined input and native wire budget include prior seeds and current ledger; failure rolls back', () => {
 const scope = fixture({ reuseResults: true }), context = createEvidenceContext('snap'); warm(scope, context);
 const existing = [{ request: { kind: 'read', id: 'new', start: 1, count: 1 }, result: scope.read({ id: 'new', start: 1, count: 1 }) }];
 const before = scope.usage(); let seen;
 assert.deepEqual(context.seed(scope, request(), { sourceIds: ['old'], existing, maxInputBytes: 1, buildRequest(records) { seen = records; return retrievalRequest(request(), scope, records); } }), []);
 assert.equal(seen.length, 2); assert.deepEqual(scope.usage(), before);
 configureWireBudget(scope, { nativeOutputTools: true });
 const builder = () => ({ instructions: 'instructions', input: JSON.stringify({ snapshotId: 'snap' }) });
 const bytes = modelWireBudget({ ...builder(), nativeOutputTools: true }, 98304).bytes;
 assert.deepEqual(context.seed(scope, request(), { sourceIds: ['old'], maxInputBytes: bytes - 1, buildRequest: builder }), []); assert.deepEqual(scope.usage(), before);
 assert.equal(context.seed(scope, request(), { sourceIds: ['old'], maxInputBytes: bytes, buildRequest: builder }).length, 1);
});

test('shared stage allocator cache hit costs no materialization but recharges output; misses and bytes exhaust safely', () => {
 const root = fixture({ reuseResults: true, maxCalls: 1 }), context = createEvidenceContext('snap'); warm(root, context);
 const allocation = createReviewReaderAllocation(root, [{ id: 'synthesis', weight: 1 }, { id: 'later', weight: 1 }]), stage = allocation.scope('synthesis'); const before = root.usage();
 assert.equal(context.seed(stage, request(), { sourceIds: ['old'] }).length, 1); assert.equal(root.usage().calls, before.calls); assert.equal(root.usage().cacheHits, before.cacheHits + 1); assert.ok(stage.usage().outputBytes > 0);
 assert.deepEqual(context.seed(stage, request(), { ranges: [{ sourceId: 'old', start: 11, count: 1 }] }), []);
 const exhausted = fixture({ maxOutputBytes: 1 }), usage = exhausted.usage(); assert.deepEqual(context.seed(exhausted, request(), { sourceIds: ['old'] }), []); assert.deepEqual(exhausted.usage(), usage);
});

test('optional materializations preserve two mandatory calls and 4KiB output; exact cache bypasses calls only', () => {
 const context = createEvidenceContext('snap'), prior = fixture(); warm(prior, context);
 const low = fixture({ maxCalls: 2 }), before = low.usage();
 assert.deepEqual(context.seed(low, request(), { sourceIds: ['old'] }), []); assert.deepEqual(low.usage(), before);
 const enough = fixture({ maxCalls: 3 }); assert.equal(context.seed(enough, request(), { sourceIds: ['old'] }).length, 1); assert.equal(enough.budget().remainingCalls, 2);
 const cached = fixture({ reuseResults: true, maxCalls: 1 }); warm(cached, context); const cachedBefore = cached.usage();
 assert.equal(context.seed(cached, request(), { sourceIds: ['old'] }).length, 1); assert.equal(cached.usage().calls, cachedBefore.calls);
 const smallBytes = fixture({ reuseResults: true, maxCalls: 1, maxOutputBytes: 4200 }); warm(smallBytes, context); const smallBefore = smallBytes.usage();
 assert.deepEqual(context.seed(smallBytes, request(), { sourceIds: ['old'] }), []); assert.deepEqual(smallBytes.usage(), smallBefore);
 // Explicit zero reserve is a host policy for a final-only bounded unit, not a
 // new authorization or larger ledger. Defaults protect mandatory tail work.
 assert.equal(context.seed(low, request(), { sourceIds: ['old'], reserveCalls: 0, reserveBytes: 0 }).length, 1);
});

test('input fit cancellation and decorated receipt rejection publish no seeds and atomically restore root ledgers', () => {
 for (const mode of ['read', 'fit', 'receipt']) {
  const scope = fixture({ reuseResults: true }), context = createEvidenceContext('snap'); warm(scope, context); const before = scope.usage(), controller = new AbortController();
  const wrapped = { ...scope, read(operation) { const value = scope.read(operation); if (mode === 'read') controller.abort(Error('cancel replay')); return mode === 'receipt' ? { ...value, receiptId: 'prior' } : value; } };
  const run = () => context.seed(wrapped, request(), { sourceIds: ['old'], signal: controller.signal, buildRequest(records) { if (mode === 'fit') controller.abort(Error('cancel replay')); return retrievalRequest(request(), scope, records); } });
  if (mode === 'receipt') assert.deepEqual(run(), []); else assert.throws(run, /cancel replay/);
  assert.deepEqual(scope.usage(), before); assert.equal(context.size(), 1);
 }
});

test('multi-item replay is atomic when a later cancellation or error abandons earlier successful reads', () => {
 for (const allocated of [false, true]) for (const failure of ['cancel-read', 'cancel-fit', 'builder', 'authorization']) {
  const root = fixture({ reuseResults: true }), context = createEvidenceContext('snap');
  warm(root, context, 'old'); warm(root, context, 'new');
  const allocation = allocated ? createReviewReaderAllocation(root, [{ id: 'stage', weight: 1 }, { id: 'later', weight: 1 }]) : undefined;
  const stage = allocation ? allocation.scope('stage') : root;
  const before = root.usage(), stageBefore = stage.usage(), controller = new AbortController(); let readCount = 0, fits = 0;
  const wrapped = { ...stage, read(operation) {
   readCount++; if (readCount === 2 && failure === 'authorization') throw Error('second source unauthorized');
   const result = stage.read(operation);
   if (readCount === 2 && failure === 'cancel-read') controller.abort(Error('second item cancelled'));
   return result;
  } };
  assert.throws(() => context.seed(wrapped, request(), { sourceIds: ['old', 'new'], signal: controller.signal, buildRequest(records) {
   fits++; if (fits === 2 && failure === 'builder') throw Error('second builder failed');
   if (fits === 2 && failure === 'cancel-fit') controller.abort(Error('second item cancelled'));
   return retrievalRequest(request(), stage, records);
  } }), /second/);
  assert.equal(readCount, 2); assert.deepEqual(root.usage(), before); assert.deepEqual(stage.usage(), stageBefore); assert.equal(context.size(), 2);
 }
});

test('second optional capacity failure returns no siblings and restores root stage and exact cache state', () => {
 for (const allocated of [false, true]) for (const failure of ['wire', 'bytes', 'hash']) {
  const root = fixture({ reuseResults: true }), context = createEvidenceContext('snap'); const first = warm(root, context, 'old'); warm(root, context, 'new');
  const allocation = allocated ? createReviewReaderAllocation(root, [{ id: 'stage', weight: 1 }, { id: 'later', weight: 1 }]) : undefined;
  const stage = allocation ? allocation.scope('stage') : root;
  let reads = 0;
  const firstSize = Buffer.byteLength(JSON.stringify([{ request: { kind: 'read', id: 'old', start: 10, count: 8 }, result: first }]));
  const baseline = root.usage(), stageBaseline = stage.usage();
  const wrapped = { ...stage, read(operation) { reads++; const result = stage.read(operation); return reads === 2 && failure === 'hash' ? { ...result, hash: 'f'.repeat(64) } : result; } };
  const result = context.seed(wrapped, request(), { sourceIds: ['old', 'new'], maxInputBytes: 98304, maxBytes: failure === 'bytes' ? firstSize + 1 : 16384, buildRequest(records) { return records.length === 2 && failure === 'wire' ? { instructions: 'x'.repeat(98305), input: '{}' } : retrievalRequest(request(), stage, records); } });
  assert.deepEqual(result, []); assert.equal(reads, 2); assert.deepEqual(root.usage(), baseline); assert.deepEqual(stage.usage(), stageBaseline); assert.equal(context.size(), 2);
 }
});

test('only sender-admitted current reads count as current-stage audit, not stored coordinates or seeds alone', async () => {
 const scope = fixture({ reuseResults: true }), context = createEvidenceContext('snap'); warm(scope, context); const reads = [];
 const req = request(), seeds = context.seed(scope, req, { sourceIds: ['old'] }); assert.equal(reads.length, 0);
 let received;
 const result = await retrievalLoop(async next => { received = JSON.parse(next.input); return { findings: [], limitations: [] }; }, req, scope, { initialRetrieved: seeds, onRetrieved: records => { reads.push(...records); context.remember(records); } });
 assert.deepEqual(result, { findings: [], limitations: [] }); assert.equal(reads.length, 1); assert.equal(received.retrieved[0].result.sourceId, 'old');
 const abandoned = context.seed(scope, req, { sourceIds: ['old'] }); const admitted = reads.length;
 await assert.rejects(retrievalLoop(async () => assert.fail('blocked sender'), req, scope, { initialRetrieved: abandoned, beforeCall() { throw Error('model gate'); }, onRetrieved: records => reads.push(...records) }), /model gate/);
 assert.equal(reads.length, admitted);
});

test('strict internal API and authorization failures propagate rather than expand approved scope', () => {
 assert.throws(() => createEvidenceContext('', {}), /Invalid evidence context/); assert.throws(() => createEvidenceContext('snap', { maxEntries: 513 }), /Invalid evidence context/);
 const scope = fixture(), context = createEvidenceContext('snap'); warm(scope, context);
 for (const options of [{ maxReads: 9 }, { maxReads: -1 }, { maxLines: 201 }, { maxBytes: 0 }, { maxInputBytes: 0 }, { reserveCalls: -1 }, { reserveBytes: -1 }, { sourceIds: [''] }, { ranges: [{ sourceId: 'old', start: 0, count: 1 }] }, { signal: {} }]) assert.throws(() => context.seed(scope, request(), options), /Invalid evidence context/);
 const before = scope.usage(); assert.throws(() => context.seed({ ...scope, read() { throw Error('authorization changed'); } }, request(), { sourceIds: ['old'] }), /authorization changed/); assert.deepEqual(scope.usage(), before);
 assert.throws(() => context.seed(scope, request(), { sourceIds: ['old'], buildRequest: () => ({}) }), /Invalid evidence context request builder/); assert.deepEqual(scope.usage(), before);
});
