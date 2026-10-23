import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiagnostics, diagnosticsMarkdown } from '../src/review-diagnostics.mjs';
test('diagnostics aggregate known phases only without exposing source, prompts or provider errors', () => {
  const report = { modelCalls: 2, files: [{ text: 'SECRET', path: 'PRIVATE', modelMetrics: { primary: { calls: 2, durationMs: 2000, inputBytes: 10, totalOutputBytes: 3 }, injected: { calls: 100, durationMs: 99999 } }, riskPlans: [{ status: 'fallback', reason: 'PRIVATE' }] }] };
  const d = reviewDiagnostics(report, { reviewWallMs: 1100 });
  assert.equal(d.phases[0].observedCallWallSumMs, 2000);
  assert.equal(d.reviewWallMs, 1100);
  assert.equal(d.observedModelCalls, 2);
  assert.equal(d.phases.length, 1);
  assert.equal(d.planning.fallback, 1);
  assert.doesNotMatch(JSON.stringify(d), /SECRET|PRIVATE|injected/);
  assert.match(diagnosticsMarkdown(d).join(' '), /可能并发重叠/);
  assert.equal(d.executionWallMs, null);
});
test('missing call observations are unavailable, never zero-provider-time claims', () => {
  const d = reviewDiagnostics({ files: [], modelCalls: 0 });
  assert.equal(d.observedModelCalls, null);
  assert.equal(d.reviewWallMs, null);
  assert.match(diagnosticsMarkdown(d).join(' '), /不可用/);
  assert.equal(reviewDiagnostics({ files: [{ modelMetrics: { primary: { durationMs: 1 } } }] }).observedModelCalls, null);
});
