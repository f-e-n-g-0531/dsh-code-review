import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
const snapshot = (before, after) => ({ id: 'snapshot', vcs: 'git', files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', left: { text: before }, right: { text: after }, properties: [] }] });
test('review passes deterministic diff and full sources without trusting supplied changes', async () => {
  const input = snapshot('a\nb\n', 'a\nx\n');
  input.files[0].changes = { status: 'unchanged' };
  const report = await reviewSnapshot(input, async request => {
    const payload = JSON.parse(request.input);
    assert.equal(payload.changes.status, 'changed');
    assert.equal(payload.changes.edits[0].new.start, 2);
    assert.equal(payload.changes.edits[0].added, undefined);
    assert.equal(payload.changes.hunks[0].new.text, undefined);
    assert.deepEqual(payload.changes.hunks[0].editIds, ['e1']);
    assert.equal(payload.file.left.text, 'a\nb\n');
    assert.equal(payload.file.right.text, 'a\nx\n');
    return { findings: [], limitations: [] };
  });
  assert.equal(report.status, 'completed');
});
test('diff limits remain visible when full text review succeeds', async () => {
  const report = await reviewSnapshot(snapshot('a\n'.repeat(500), 'b\n'.repeat(500)), async request => {
    assert.equal(JSON.parse(request.input).changes.status, 'limited');
    return { findings: [], limitations: [] };
  });
  assert.equal(report.modelCalls, 1);
  assert.equal(report.status, 'partial');
  assert.match(report.limitations[0].text, /精确变更分析受限/);
});
