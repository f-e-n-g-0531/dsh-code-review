import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSynthesisReads } from '../src/synthesis-evidence.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { prepareWindowSynthesis } from '../src/window-synthesis.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';

const findings = [{ attribution: { editIds: ['e1'] } }];
const changes = { edits: [{ id: 'e1', old: { start: 1, count: 0 }, new: { start: 1, count: 401 } }] };
const catalog = [
 { id: 'new', fileId: 'f', side: 'new' },
 { id: 'alias', fileId: 'f', side: 'new' },
 { id: 'old', fileId: 'f', side: 'old' },
 { id: 'other', fileId: 'other', side: 'new' },
];
const read = (start, count, extra = {}) => ({ kind: 'read', snapshotId: 'snap', sourceId: 'new', start, count, ...extra });
const validate = reads => validateSynthesisReads(findings, changes, reads, catalog, 'f', 'snap');

test('reader-sized adjacent, overlapping and out-of-order reads cover a large edit', () => {
 const reader = createSnapshotReader('snap', [{ id: 'new', text: Array(401).fill('line').join('\n') }]);
 assert.throws(() => reader.read({ id: 'new', start: 1, count: 401 }), /Invalid line range/);
 const reads = [201, 1, 401].map(start => ({ kind: 'read', ...reader.read({ id: 'new', start, count: Math.min(200, 402 - start) }) }));
 assert.doesNotThrow(() => validate(reads));
 assert.doesNotThrow(() => validate([read(190, 200), read(389, 13), read(1, 200), read(1, 20)]));
 assert.doesNotThrow(() => validateSynthesisReads(findings, { edits: [{ id: 'e1', old: { start: 1, count: 401 }, new: { start: 1, count: 0 } }] }, reads.map(r => ({ ...r, sourceId: 'old' })), catalog, 'f', 'snap'));
});

test('evidence union does not bridge gaps, identities, sides, snapshots or searches', () => {
 for (const tail of [
  read(202, 200), // one unread line
  read(201, 200, { sourceId: 'alias' }),
  read(201, 200, { sourceId: 'old' }),
  read(201, 200, { sourceId: 'other' }),
  read(201, 200, { sourceId: 'unauthorized' }),
  read(201, 200, { snapshotId: 'prior-generation' }),
  read(201, 200, { kind: 'search' }),
  read(201, 0), read(201, -1), read(201, NaN), read(201, Infinity),
  read(201, '200'), read(201.5, 200),
 ]) assert.throws(() => validate([read(1, 200), tail, read(401, 1)]), /not read/);
 assert.throws(() => validate([read(1, 200), read(201, 200)]), /not read/);
 assert.throws(() => validateSynthesisReads([{ attribution: { editIds: ['missing'] } }], changes, [read(1, 401)], catalog, 'f', 'snap'), /not read/);
});

const batch = id => JSON.stringify({ snapshotId: 'snap', file: { id: 'f' }, sourceMode: 'change-windows', windows: [{ id, editIds: ['e' + id], old: { start: 1, count: 1, text: 'OLD' }, new: { start: 1, count: 1, text: 'NEW' } }] });
test('synthesis limit returns explicit blocked without measuring or truncating batches', () => {
 const blocked = prepareWindowSynthesis(Array.from({ length: 21 }, (_, i) => batch(String(i))), () => assert.fail('must not schedule oversized synthesis'));
 assert.deepEqual(blocked, { status: 'blocked', reason: 'batch-limit', batchCount: 21 });
 const ready = prepareWindowSynthesis([batch('1'), batch('2')], () => ({ fits: true, bytes: 1 }));
 assert.equal(ready.status, 'ready');
 assert.deepEqual(JSON.parse(ready.payload).windowIndex.map(w => w.id), ['1', '2']);
 assert.ok(!ready.payload.includes('OLD'));
 assert.equal(prepareWindowSynthesis([batch('1'), batch('2')], () => ({ fits: false, bytes: 99999 })).reason, 'input-budget');
 assert.throws(() => prepareWindowSynthesis([batch('1'), batch('1')], () => ({ fits: true })), /Inconsistent/);
 assert.throws(() => prepareWindowSynthesis([batch('1'), batch('2').replace('snap', 'wrong')], () => ({ fits: true })), /Inconsistent/);
});

const file = (id, left, right) => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: left }, right: { text: right } });
const finding = (id, snippet, editIds) => ({ fileId: id, severity: 'medium', title: 'retained candidate', evidence: snippet, trigger: 'run', impact: 'failure', suggestion: 'restore', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet }, attribution: { editIds, properties: [], beforeBehavior: 'before', afterBehavior: 'after', reason: 'changed' } });
const manyBatchSnapshot = () => ({ id: 'snap', vcs: 'git', context: [], files: [
 file('small', 'before', 'after'),
 file('large', Array.from({ length: 2100 }, (_, i) => 'old' + i + 'x'.repeat(20)).join('\n'), Array.from({ length: 2100 }, (_, i) => 'new' + i + 'y'.repeat(20)).join('\n')),
] });

test('small budget with >20 batches preserves prior findings and every primary window, only synthesis blocked', async () => {
 const snapshot = manyBatchSnapshot();
 const options = { instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(snapshot), maxInputBytes: 12000 };
 const prepared = preparePrimaryInput(snapshot, snapshot.files[1], options);
 assert.ok(prepared.batches.length > 20);
 assert.equal(prepared.synthesis.status, 'blocked');
 const plan = buildCoveragePlan(snapshot, options);
 assert.equal(plan.items.find(i => i.fileId === 'large').synthesisBlockedReason, 'batch-limit');
 assert.equal(plan.minimumCalls, prepared.batches.length + 1);
 const seen = [];
 const report = await reviewSnapshot(snapshot, async request => {
  const p = JSON.parse(request.input);
  assert.notEqual(p.sourceMode, 'window-synthesis');
  if (p.file.id === 'small') return { findings: [finding('small', 'after', ['e1'])], limitations: [] };
  seen.push(...p.windows.map(w => w.id));
  return { findings: [], limitations: [] };
 }, { enableRetrieval: true, maxInputBytes: 12000 });
 assert.deepEqual(seen, prepared.metadata.windowIds);
 assert.equal(report.files[0].status, 'completed');
 assert.equal(report.findings[0].fileId, 'small');
 assert.equal(report.files[1].status, 'completed');
 assert.equal(report.files[1].synthesisStatus, 'blocked');
 assert.equal(report.files[1].synthesisBlockedReason, 'batch-limit');
 assert.equal(report.files[1].stageFailures, undefined);
 assert.deepEqual(report.files[1].windowCoverage.pending, []);
 assert.deepEqual(report.files[1].windowCoverage.completed, seen);
 assert.equal(report.modelCalls, plan.minimumCalls);
 assert.equal(report.status, 'partial');
 assert.ok(report.limitations.some(l => l.fileId === 'large' && l.text.includes('20') && l.text.includes('不表示交互影响已检查')));
 assert.ok(report.followup.suggestedPaths.includes('large.js'));
});

test('synthesis accepts a >200-line edit read in separate approved chunks', async () => {
 const before = Array.from({ length: 401 }, (_, i) => 'old' + i + 'x'.repeat(20));
 const after = Array.from({ length: 401 }, (_, i) => 'new' + i + 'y'.repeat(20));
 const snapshot = { id: 'snap', vcs: 'git', context: [], files: [file('chunked', before.join('\n'), after.join('\n'))] };
 let synthesisCalls = 0;
 const report = await reviewSnapshot(snapshot, async request => {
  const p = JSON.parse(request.input);
  if (p.sourceMode !== 'window-synthesis') return { findings: [], limitations: [] };
  synthesisCalls++;
  if (!p.retrieved.length) return { requests: [
   { kind: 'read', id: 's2', start: 1, count: 200 },
   { kind: 'read', id: 's2', start: 201, count: 200 },
   { kind: 'read', id: 's2', start: 401, count: 1 },
  ] };
  return { findings: [finding('chunked', after[0], ['e1'])], limitations: [] };
 }, { enableRetrieval: true, maxInputBytes: 18000 });
 assert.equal(synthesisCalls, 2);
 assert.equal(report.findings.length, 1);
 assert.equal(report.files[0].synthesisStatus, 'completed');
 assert.equal(report.status, 'completed');
 assert.equal(report.files[0].retrievalAudit.length, 3);
});

test('normal multi-window synthesis still executes and completes', async () => {
 const before = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
 const after = [...before]; after[10] = 'changed10'; after[80] = 'changed80';
 const snapshot = { id: 'snap', vcs: 'git', context: [], files: [file('normal', before.join('\n'), after.join('\n'))] };
 let synthesisCalls = 0;
 const report = await reviewSnapshot(snapshot, async request => {
  if (JSON.parse(request.input).sourceMode === 'window-synthesis') synthesisCalls++;
  return { findings: [], limitations: [] };
 }, { enableRetrieval: true, maxInputBytes: 8000 });
 assert.equal(synthesisCalls, 1);
 assert.equal(report.files[0].synthesisStatus, 'completed');
 assert.equal(report.status, 'completed');
 assert.equal(report.modelCalls, 3);
});
