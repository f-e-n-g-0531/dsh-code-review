import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
const snapshot = () => ({ id: 's', vcs: 'git', files: ['src/a.ts', 'test/a.test.ts'].map(id => ({ id, path: id, eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] })), context: [] });
test('group context retains one primary review per file with approved related sides', async () => {
  const seen = [];
  const report = await reviewSnapshot(snapshot(), async request => {
    const p = JSON.parse(request.input); seen.push(p.file.id);
    assert.equal(p.relatedFiles.length, 1);
    assert.notEqual(p.relatedFiles[0].id, p.file.id);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true });
  assert.equal(report.status, 'completed'); assert.equal(new Set(seen).size, 2);
  assert.equal(report.grouping.groups.length, 1);
});
test('retrieval overhead participates in grouping fallback before any model call', async () => {
  let groupedBytes = 0;
  await reviewSnapshot(snapshot(), async r => { groupedBytes = Math.max(groupedBytes, Buffer.byteLength(r.input) + Buffer.byteLength(r.instructions)); return { findings: [], limitations: [] }; }, { enableGrouping: true });
  const result = await reviewSnapshot(snapshot(), async r => {
    assert.ok(Buffer.byteLength(r.input) + Buffer.byteLength(r.instructions) <= groupedBytes);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true, enableRetrieval: true, maxInputBytes: groupedBytes });
  assert.ok(result.files.every(f => f.groupFallback === 'input-budget'));
  assert.ok(result.files.every(f => f.status !== 'failed'));
});

test('over-budget related text falls back without hiding missing group coverage', async () => {
  const s = snapshot(); s.files[1].right.text = 'x'.repeat(6000);
  const report = await reviewSnapshot(s, async request => {
    assert.equal(JSON.parse(request.input).relatedFiles, undefined);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true, maxInputBytes: 5000 });
  assert.equal(report.status, 'partial');
  assert.equal(report.files[0].groupFallback, 'input-budget');
  assert.equal(report.files[0].status, 'completed');
  assert.equal(report.files[1].status, 'blocked');
});
