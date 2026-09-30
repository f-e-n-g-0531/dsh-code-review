import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
const snapshot = { id: 'snap', vcs: 'git', files: [{ id: 'f1', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }] };
const generated = { findings: [{ fileId: 'f1', severity: 'high', title: 'bug', evidence: 'e', trigger: 't', impact: 'i', suggestion: 's', anchor: { kind: 'file' } }], limitations: [] };
const options = { enableRetrieval: true, enableVerification: true };
test('optional verification shares model budget and retains candidates on exhaustion', async () => {
  const report = await reviewSnapshot(snapshot, async () => generated, { ...options, maxCalls: 1 });
  assert.equal(report.modelCalls, 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.status, 'incomplete');
  assert.equal(report.status, 'partial');
});
test('generation and verification receive same timeout signal', async () => {
  let first; let calls = 0; let cleaned = false;
  const report = await reviewSnapshot(snapshot, async ({ signal }) => {
    if (++calls === 1) { first = signal; return generated; }
    assert.equal(signal, first);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    cleaned = true; throw signal.reason;
  }, { ...options, timeoutMs: 30 });
  assert.equal(cleaned, true); assert.equal(report.status, 'failed');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.status, 'incomplete');
});
test('uncertain verdict is retained without rewriting candidate anchor', async () => {
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async () => ++calls === 1 ? generated : { verdicts: [{ candidateId: 'c1', verdict: 'uncertain', reason: 'Need more context', evidence: [] }] }, options);
  assert.equal(report.modelCalls, 2);
  assert.equal(report.findings[0].verification.verdict, 'uncertain');
  assert.deepEqual(report.findings[0].anchor, { kind: 'file' });
});
