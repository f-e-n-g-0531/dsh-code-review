import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
import { prepareReviewHistory, finishReviewHistory, reviewHistoryIdentity, reviewSourceManifest } from '../src/review-history.mjs';

const route = { provider: 'fixture', model: 'never-network' };
const source = (vcs = 'git') => ({ id: 'snapshot-1', root: '/repo', vcs, context: [], ...(vcs === 'svn' ? { repositoryUuid: 'uuid-A', repositoryUrl: 'https://example.invalid/repo' } : {}), files: [{ id: 'file-1', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'new();' } }] });
const finish = snapshot => finishReviewHistory({ snapshotId: snapshot.id, files: [], findings: [] }, prepareReviewHistory(snapshot, route, {}));
const jobId = '11111111-1111-1111-1111-111111111111';
function serviceFixture(t, initial = source()) {
  let snapshot = initial, calls = 0;
  const service = createReviewService({ async *stream() { calls++; yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { capture: async () => structuredClone(snapshot), allowModelSending: true, authorize: async () => true });
  t.after(() => service.dispose());
  const exec = { agent: { session: { header: { cwd: '/repo' } }, options: route }, signal: new AbortController().signal };
  return { service, exec, set: value => { snapshot = value; }, get calls() { return calls; } };
}
async function first(f, args = {}) {
  const preview = await f.service.preview(args, f.exec);
  const result = await f.service.execute({ previewId: preview.previewId, confirmed: true }, f.exec);
  f.exec.resolvePriorReview = async () => structuredClone(result.report.reviewHistory);
  return result;
}
for (const field of ['repositoryUuid', 'repositoryUrl']) test('working SVN top-level ' + field + ' drift rejects owned history before model', async t => {
  const original = source('svn'), f = serviceFixture(t, original);
  await first(f);
  const changed = structuredClone(original); changed.id = 'snapshot-2'; changed[field] += '-different'; f.set(changed);
  assert.notEqual(reviewHistoryIdentity(original, route).repository, reviewHistoryIdentity(changed, route).repository);
  await assert.rejects(f.service.preview({ rereviewFromJobId: jobId }, f.exec), /identity mismatch/);
  assert.equal(f.calls, 1);
});
test('Git snapshot and file IDs may drift without changing source hash or repository chain', async t => {
  const original = source(), next = structuredClone(original); next.id = 'snapshot-2'; next.files[0].id = 'reassigned-file-id';
  const identity = reviewHistoryIdentity(original, route);
  assert.equal(reviewSourceManifest(original, identity).files[0].hash, reviewSourceManifest(next, identity).files[0].hash);
  const f = serviceFixture(t, original); await first(f); f.set(next);
  const preview = await f.service.preview({ rereviewFromJobId: jobId }, f.exec);
  assert.equal(preview.rereview.cycle, 2); assert.equal(preview.rereview.incremental.mode, 'full-fresh-primary');
  const result = await f.service.execute({ previewId: preview.previewId, confirmed: true }, f.exec);
  assert.equal(result.report.reviewHistory.ledger.cycle, 2); assert.equal(f.calls, 2);
});
test('same SVN repository accepts a changed file inventory without treating it as relocation', () => {
  const original = source('svn');
  original.files[0].workingSource = { url: original.repositoryUrl + '/a.js' };
  const next = structuredClone(original); next.id = 'snapshot-2'; next.files = [{ ...next.files[0], id: 'file-b', path: 'b.js', workingSource: { url: original.repositoryUrl + '/b.js' } }];
  const prepared = prepareReviewHistory(next, route, {}, { previous: finish(original) });
  assert.equal(prepared.previous.cycle, 1); assert.deepEqual(prepared.selection.plan.primaryPaths, ['b.js']);
});
for (const change of ['effort', 'rules', 'capture']) test(change + ' policy drift rejects linked service preview', async t => {
  const initial = source(); initial.rules = [{ path: 'rules.md', text: 'exact original rules', hash: 'a'.repeat(64) }];
  const f = serviceFixture(t, initial); await first(f);
  const args = { rereviewFromJobId: jobId };
  if (change === 'effort') args.reviewEffort = 'deep';
  if (change === 'capture') args.contextPaths = ['approved-extra.js'];
  if (change === 'rules') { const next = structuredClone(initial); next.id = 'rules-changed'; next.rules[0].text = 'different rule content'; next.rules[0].hash = 'b'.repeat(64); f.set(next); }
  await assert.rejects(f.service.preview(args, f.exec), /identity mismatch/); assert.equal(f.calls, 1);
});
test('same policy canonical field order stays stable but requirement and route drift reject', () => {
  const original = source(), previous = finishReviewHistory({ snapshotId: original.id, findings: [], files: [] }, prepareReviewHistory(original, route, { selectedPaths: ['a.js'], autoContext: true }));
  assert.doesNotThrow(() => prepareReviewHistory(original, route, { autoContext: true, selectedPaths: ['a.js'] }, { previous }));
  assert.throws(() => prepareReviewHistory({ ...original, businessRequirement: 'new requirement' }, route, { autoContext: true, selectedPaths: ['a.js'] }, { previous }), /identity mismatch/);
  assert.throws(() => prepareReviewHistory(original, { ...route, model: 'other' }, { autoContext: true, selectedPaths: ['a.js'] }, { previous }), /identity mismatch/);
});
test('legal SVN root property finding finalizes and root manifest links second cycle', () => {
  const root = source('svn'); root.files = [{ id: 'root', path: '.', kind: 'dir', eligibility: 'reviewable', properties: [{ name: 'svn:ignore', old: 'a', new: 'b' }], left: { text: '' }, right: { text: '' } }];
  const prepared = prepareReviewHistory(root, route, {});
  const finding = { fileId: 'root', anchor: { kind: 'property', name: 'svn:ignore' }, evidence: 'Ignore rule removed', trigger: 'Generated outputs exist', impact: 'Unintended files tracked' };
  const report = { snapshotId: root.id, files: [{ fileId: 'root', path: '.', kind: 'dir' }], findings: [finding] };
  const previous = finishReviewHistory(report, prepared);
  assert.equal(previous.ledger.findings[0].path, '.');
  const next = structuredClone(root); next.id = 'snapshot-2'; next.files[0].eligibility = 'excluded'; next.files[0].reason = 'Not explicitly selected';
  const again = prepareReviewHistory(next, route, {}, { previous });
  assert.equal(again.selection.plan.mode, 'full-fresh-primary');
  const result = finishReviewHistory({ snapshotId: next.id, files: [], findings: [] }, again);
  assert.equal(result.ledger.cycle, 2); assert.equal(result.ledger.findings[0].observation, 'not-observed');
});
