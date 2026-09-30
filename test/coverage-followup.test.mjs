import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
import { coverageFollowup } from '../src/coverage-followup.mjs';
test('followup distinguishes primary completion from incomplete verification', () => {
  const files = ['completed','excluded','blocked','failed','cancelled','pending'].map((status,i) => ({ fileId: String(i), path: i+'.js', status }));
  const report = { snapshotId: 's', files, findings: [{ fileId: '0', verification: { status: 'incomplete' } }] };
  const result = coverageFollowup(report);
  assert.deepEqual(result.suggestedPaths, ['0.js','2.js','3.js','4.js','5.js']);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.requiresNewPreview, true);
  assert.deepEqual(result, coverageFollowup({ ...report, files: [...files].reverse() }));
  result.items[0].path = 'mutation';
  assert.equal(files[0].path, '0.js');
  assert.deepEqual(coverageFollowup({ ...report, findings: [] }).suggestedPaths, ['2.js','3.js','4.js','5.js']);
});
test('review integrates budget followup and escapes suggested paths', async () => {
  const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] };
  const snapshot = { id: 's', vcs: 'git', files: [file, { ...file, id: 'b', path: '<b>.js' }] };
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async () => { calls++; return { findings: [], limitations: [] }; }, { maxCalls: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(report.followup.suggestedPaths, ['<b>.js']);
  assert.match(markdownReport(report), /新预览、新审批/);
  assert.ok(!markdownReport(report).includes('<b>'));
  await assert.rejects(reviewSnapshot({ ...snapshot, files: [file, { ...file, id: 'b' }] }, () => assert.fail('duplicate sent')), /duplicate/);
});
test('related context sent once remains pending as an unaudited primary', async () => {
  const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] };
  const snapshot = { id: 's', vcs: 'git', files: [file, { ...file, id: 'b', path: 'a.test.js' }] };
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async request => {
    calls++;
    assert.deepEqual(JSON.parse(request.input).relatedFiles.map(f => f.id), ['b']);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true, maxCalls: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(report.files[0].relatedFileIds, ['b']);
  assert.equal(report.files[1].status, 'pending');
  assert.deepEqual(report.followup.suggestedPaths, ['a.test.js']);
});
test('cancelled and failed execution preserve exact remaining suggestions', async () => {
  const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] };
  const input = { id: 's', vcs: 'svn', files: [file, { ...file, id: 'b', path: 'b.js' }, { id: 'c', path: 'excluded', eligibility: 'excluded' }] };
  const c = new AbortController(); c.abort(new Error('cancel'));
  const cancelled = await reviewSnapshot(input, () => assert.fail('cancelled model send'), { signal: c.signal });
  assert.equal(cancelled.modelCalls, 0);
  assert.equal(cancelled.coverage.cancelled, 2);
  assert.deepEqual(cancelled.followup.suggestedPaths, ['a.js', 'b.js']);
  let calls = 0;
  const failed = await reviewSnapshot(input, async () => {
    if (++calls === 1) throw new Error('adapter failure');
    return { findings: [], limitations: [] };
  });
  assert.equal(calls, 2);
  assert.equal(failed.coverage.failed, 1);
  assert.equal(failed.coverage.completed, 1);
  assert.deepEqual(failed.followup.suggestedPaths, ['a.js']);
});
test('invalid or ambiguous coverage does not produce suggestions', () => {
  const file = { fileId: 'f', path: 'a', status: 'completed' };
  for (const files of [[file,file], [{...file,status:'unknown'}], Array(201).fill(file)]) assert.throws(() => coverageFollowup({ snapshotId: 's', files, findings: [] }), /Invalid/);
});
