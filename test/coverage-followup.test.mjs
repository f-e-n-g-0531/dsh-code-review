import test from 'node:test';
import assert from 'node:assert/strict';
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
test('invalid or ambiguous coverage does not produce suggestions', () => {
  const file = { fileId: 'f', path: 'a', status: 'completed' };
  for (const files of [[file,file], [{...file,status:'unknown'}], Array(201).fill(file)]) assert.throws(() => coverageFollowup({ snapshotId: 's', files, findings: [] }), /Invalid/);
});
