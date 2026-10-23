import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiagnostics, diagnosticsMarkdown } from '../src/review-diagnostics.mjs';

const metrics = (calls, durationMs = 100) => ({ calls, durationMs, inputBytes: calls * 1000, totalOutputBytes: calls * 100 });

test('shared grouping and group primary metrics are counted once alongside file metrics', () => {
  const files = Array.from({ length: 74 }, () => ({ modelMetrics: { primary: metrics(1) }, modelCallPurposes: { 'primary-initial': 1 } }));
  const report = { files, modelCalls: 78, orchestration: {
    modelMetrics: { 'business-grouping': metrics(1, 600), 'group-primary': metrics(3, 900) },
    modelCallPurposes: { 'business-grouping': 1, 'primary-initial': 3 },
    modelCorrections: [], retrievalLimits: [],
  } };
  const d = reviewDiagnostics(report);
  assert.equal(d.schemaVersion, 2);
  assert.equal(d.observedModelCalls, 78);
  assert.deepEqual(d.phases.map(row => [row.phase, row.calls]), [['business-grouping', 1], ['primary', 74], ['group-primary', 3]]);
  assert.equal(d.phases.find(row => row.phase === 'group-primary').observedCallWallSumMs, 900);
  assert.deepEqual(d.modelCallPurposes, [{ purpose: 'primary-initial', calls: 77 }, { purpose: 'business-grouping', calls: 1 }]);
  assert.match(diagnosticsMarkdown(d).join('\n'), /group-primary/);
  assert.deepEqual(report.files, files);
});

test('shared correction and reader limits join per-file events without double counting completion notices', () => {
  const event = { action: 'explicit-json-correction', code: 'MODEL_INVALID_JSON', jsonIssue: 'separator' };
  const d = reviewDiagnostics({ files: [{ modelCorrections: [event], retrievalLimits: [{ code: 'READER_CALL_BUDGET_EXCEEDED' }] }],
    orchestration: { modelCorrections: [event, { ...event, action: 'json-correction-complete' }], retrievalLimits: [{ code: 'READER_OUTPUT_BUDGET_EXCEEDED' }],
      modelCallPurposes: { 'group-primary': 2 }, modelMetrics: { 'group-primary': metrics(2) } } });
  assert.deepEqual(d.correctionReasons, [{ code: 'MODEL_INVALID_JSON', jsonIssue: 'separator', calls: 2 }]);
  assert.deepEqual(d.readerLimitReasons, [{ code: 'READER_CALL_BUDGET_EXCEEDED', calls: 1 }, { code: 'READER_OUTPUT_BUDGET_EXCEEDED', calls: 1 }]);
  assert.deepEqual(d.modelCallPurposes, [{ purpose: 'group-primary', calls: 2 }]);
});

test('missing shared observations are unavailable rather than zero and mixed incomplete metrics stay unavailable', () => {
  const missing = reviewDiagnostics({ files: [], orchestration: {} });
  assert.equal(missing.observedModelCalls, null);
  assert.deepEqual(missing.phases, []);
  const mixed = reviewDiagnostics({ files: [{ modelMetrics: { primary: metrics(1) } }], orchestration: { modelMetrics: { primary: { calls: 1 } } } });
  assert.equal(mixed.observedModelCalls, 2);
  assert.equal(mixed.phases[0].observedCallWallSumMs, null);
  assert.equal(mixed.phases[0].inputBytes, null);
});

test('resumed completed files add no old model or reader metrics and expose only reused count', () => {
  const d = reviewDiagnostics({ modelCalls: 2, files: [
    { status: 'completed', resumed: true, path: 'PRIVATE', findings: [{ evidence: 'PRIVATE' }] },
    { modelMetrics: { primary: metrics(1), verification: metrics(1) } },
  ], resume: { reusedFiles: 1, sourceJobId: 'PRIVATE', originalModelCalls: 99, text: 'PRIVATE' } });
  assert.deepEqual(d.resume, { reusedFiles: 1 });
  assert.equal(d.observedModelCalls, 2);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  assert.match(diagnosticsMarkdown(d).join('\n'), /复用成果不计为本次模型调用/);
  assert.deepEqual(reviewDiagnostics({}).resume, { reusedFiles: null });
  assert.deepEqual(reviewDiagnostics({ resume: { reusedFiles: -1 } }).resume, { reusedFiles: null });
});

test('artifact diagnostics count explicit retained and omitted refs without identities or content', () => {
  const d = reviewDiagnostics({ artifacts: [
    { omitted: false, recorded: true, artifactId: 'PRIVATE', hash: 'PRIVATE', bytes: 100, status: 'failed', raw: 'PRIVATE' },
    { omitted: false, recorded: true, artifactId: 'PRIVATE', bytes: 200, status: 'accepted' },
    { omitted: true, artifactId: 'PRIVATE', bytes: 300, reason: 'PRIVATE' },
    { omitted: false, recorded: false, artifactId: 'PRIVATE' },
    { arbitrary: 'PRIVATE' }, null,
  ] });
  assert.deepEqual(d.artifacts, { retained: 2, omitted: 1 });
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  assert.match(diagnosticsMarkdown(d).join('\n'), /已留存 2，未留存 1/);
  assert.deepEqual(reviewDiagnostics({ artifacts: [] }).artifacts, { retained: 0, omitted: 0 });
  assert.deepEqual(reviewDiagnostics({}).artifacts, { retained: null, omitted: null });
});

test('transport summaries count only allowlisted successful local events with no extra model calls', () => {
  const d = reviewDiagnostics({ modelCalls: 2, files: [{ modelRecoveries: [
    { action: 'json-transport-recovery', kind: 'trailing-prose', raw: 'PRIVATE' },
    { action: 'model-end', kind: 'trailing-prose' },
  ] }], orchestration: { modelRecoveries: [
    { action: 'json-transport-recovery', kind: 'native-tool', attempt: 1 },
    { action: 'json-transport-recovery', kind: 'text-compatible', attempt: 2 },
    { action: 'json-transport-recovery', kind: 'trailing-prose', attempt: 3 },
    { action: 'json-transport-recovery', kind: 'PRIVATE' },
  ] } });
  assert.deepEqual(d.transportRecoveries, [{ kind: 'native-tool', calls: 1 }, { kind: 'text-compatible', calls: 1 }, { kind: 'trailing-prose', calls: 2 }]);
  assert.equal(d.modelCalls, 2);
  assert.equal(d.observedModelCalls, null);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  assert.match(diagnosticsMarkdown(d).join('\n'), /不表示额外模型调用/);
});

test('untrusted metadata in orchestration remains numeric allowlisted output only', () => {
  const d = reviewDiagnostics({ orchestration: {
    modelMetrics: { 'group-primary': { calls: 1, durationMs: 'PRIVATE', inputBytes: -1, totalOutputBytes: Infinity }, PRIVATE: metrics(99) },
    modelCallPurposes: { 'group-primary': 1, PRIVATE: 99 },
    modelCorrections: [{ action: 'explicit-json-correction', code: 'PRIVATE', raw: 'PRIVATE' }],
    retrievalLimits: [{ code: 'PRIVATE' }], path: 'PRIVATE', raw: 'PRIVATE', sourceJobId: 'PRIVATE',
  } });
  assert.equal(d.phases[0].observedCallWallSumMs, null);
  assert.equal(d.phases[0].inputBytes, null);
  assert.equal(d.phases[0].totalOutputBytes, null);
  assert.equal(d.observedModelCalls, 1);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  assert.ok(!diagnosticsMarkdown(d).join('\n').includes('PRIVATE'));
});
