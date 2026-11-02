import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, validateFindings } from '../src/review.mjs';
import { prepareStageGenerations } from '../src/review-stage-state.mjs';
import { reviewChangeMap } from '../src/review-change-map.mjs';
import { changeMap } from '../src/change-map.mjs';

function snapshot() {
  const before = Array.from({ length: 1200 }, (_, i) => 'old line ' + i + ' ' + 'a'.repeat(30) + '\n').join('');
  return { id: 's', vcs: 'git', files: [{ id: 'f', path: 'large.cpp', eligibility: 'reviewable', properties: [],
    left: { text: before }, right: { text: before.replaceAll('old line', 'new line') } }], context: [] };
}

test('canonical review change map preserves exact and unchanged source results and does not fabricate over-cap envelope', () => {
  for (const [before, after] of [['same\n', 'same\n'], ['old\n', 'new\n']]) assert.deepEqual(reviewChangeMap(before, after), changeMap(before, after));
  const before = 'a'.repeat(3 * 1024 * 1024), after = 'b'.repeat(3 * 1024 * 1024);
  assert.equal(reviewChangeMap(before, after).status, 'limited');
});

for (const continuation of [false, true]) test('large rewritten file really executes all original-line envelope batches and findings: continuation ' + continuation, async () => {
  const input = snapshot(), original = structuredClone(input), checkpoints = [], seen = [];
  let calls = 0;
  const report = await reviewSnapshot(input, async request => {
    calls++; const payload = JSON.parse(request.input);
    if (!payload.windows) return { findings: [], limitations: [] }; // Separate synthesis may be admitted.
    assert.equal(payload.changes.precision, 'envelope');
    assert.ok(payload.windows.every(w => w.old.start >= 1 && w.new.start >= 1));
    const w = payload.windows[0]; seen.push(...payload.windows.map(w => w.id));
    const line = w.new.start, snippet = input.files[0].right.text.split('\n')[line - 1];
    return { findings: [{ fileId: 'f', severity: 'medium', title: 'Window ' + w.id, evidence: 'Approved broad-region coordinate only',
      trigger: 'candidate trigger', impact: 'candidate impact', suggestion: 'verify guard', anchor: { kind: 'line', side: 'new', start: line, end: line, snippet },
      attribution: { editIds: ['envelope1'], properties: [], beforeBehavior: 'old path', afterBehavior: 'new path', reason: 'Broad region requires independent verification' } }], limitations: [] };
  }, { enableRetrieval: true, enableStageContinuation: continuation, maxInputBytes: 18000, onProgress: async event => checkpoints.push(event) });
  assert.ok(calls > 1); assert.ok(seen.length > 1);
  assert.equal(report.files[0].status, 'completed', report.files[0].reason);
  assert.equal(report.files[0].windowCoverage.pending.length, 0);
  assert.ok(report.findings.length > 0); assert.ok(report.findings.every(f => f.attribution.precision === 'envelope' && f.attribution.causality === 'unverified'));
  assert.ok(report.limitations.some(l => l.text.includes('包络'))); assert.ok(checkpoints.some(event => event.stage === 'window-complete'));
  const roundtrip = validateFindings({ findings: report.findings, limitations: [] }, input.files[0]);
  assert.deepEqual(roundtrip.findings.map(f => f.id), report.findings.map(f => f.id));
  if (continuation) {
    assert.ok(report.stageGenerations.length > 1);
    assert.deepEqual(prepareStageGenerations(input, report.stageGenerations), report.stageGenerations);
    assert.ok(report.stageGenerations.every(r => r.windowIds.every(id => seen.includes(id))));
  } else assert.equal(report.stageGenerations, undefined);
  assert.deepEqual(input, original);
});
