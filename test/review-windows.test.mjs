import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const snapshot = () => {
  const prefix = Array(2000).fill('unchanged line' + String.fromCharCode(10)).join('');
  return { id: 's', vcs: 'git', context: [], files: [{ id: 'f', path: 'large.js', eligibility: 'reviewable', properties: [], left: { text: prefix + 'before' }, right: { text: prefix + 'after' } }] };
};
test('oversized full input uses all exact windows with original attribution and preview parity', async () => {
  const s = snapshot(), scope = createRetrievalScope(s);
  const plan = buildCoveragePlan(s, { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 12000 });
  assert.equal(plan.items[0].status, 'ready');
  assert.equal(plan.items[0].sourceMode, 'change-windows');
  const report = await reviewSnapshot(s, async request => {
    const p = JSON.parse(request.input);
    assert.equal(p.file.right.text, undefined);
    assert.equal(p.sourceMode, 'change-windows');
    assert.ok(p.windows[0].new.start > 1900);
    return { findings: [{ fileId: 'f', severity: 'medium', title: 'regression', evidence: 'after', trigger: 'run', impact: 'failure', suggestion: 'restore', anchor: { kind: 'line', side: 'new', start: 2001, end: 2001, snippet: 'after' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'before', afterBehavior: 'after', reason: 'changed' } }], limitations: [] };
  }, { enableRetrieval: true, maxInputBytes: 12000 });
  assert.equal(report.status, 'completed');
  assert.equal(report.findings[0].anchor.start, 2001);
  assert.equal(report.files[0].initialInputBytes, plan.items[0].initialInputBytes);
  assert.equal(report.files[0].windowCoverage.completed.length, 1);
});
test('invalid response leaves every prepared window explicitly pending', async () => {
  const report = await reviewSnapshot(snapshot(), async () => ({ invalid: true }), { enableRetrieval: true, maxInputBytes: 12000 });
  assert.equal(report.files[0].status, 'failed');
  assert.deepEqual(report.files[0].windowCoverage.completed, []);
  assert.equal(report.files[0].windowCoverage.pending.length, 1);
});
test('multiple window batches share signal and preserve completed windows on budget exhaustion', async () => {
  const s = snapshot();
  const lines = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
  s.files[0].left.text = lines.join(String.fromCharCode(10));
  const changed = [...lines]; changed[10] = 'changed10'; changed[80] = 'changed80';
  s.files[0].right.text = changed.join(String.fromCharCode(10));
  const scope = createRetrievalScope(s);
  const plan = buildCoveragePlan(s, { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 8000 });
  assert.equal(plan.items[0].minimumCalls, 3);
  let firstSignal, calls = 0;
  const report = await reviewSnapshot(s, async r => {
    calls++; firstSignal ??= r.signal; assert.equal(r.signal, firstSignal);
    assert.equal(JSON.parse(r.input).windows.length, 1);
    return { findings: [], limitations: [] };
  }, { enableRetrieval: true, maxInputBytes: 8000, maxCalls: 1 });
  assert.equal(calls, 1);
  assert.equal(report.files[0].windowCoverage.completed.length, 1);
  assert.equal(report.files[0].windowCoverage.pending.length, 1);
  assert.notEqual(report.status, 'completed');
  const complete = await reviewSnapshot(s, async () => ({ findings: [], limitations: [] }), { enableRetrieval: true, maxInputBytes: 8000 });
  assert.equal(complete.files[0].windowCoverage.completed.length, 2);
  assert.equal(complete.files[0].windowCoverage.pending.length, 0);
  assert.equal(complete.files[0].synthesisStatus, 'completed');
  assert.equal(complete.modelCalls, 3);
});
test('synthesis budget exhaustion and cancellation keep completed local coverage separate', async () => {
 const s = snapshot(); const lines = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
 s.files[0].left.text = lines.join(String.fromCharCode(10));
 const changed = [...lines]; changed[10] = 'changed10'; changed[80] = 'changed80'; s.files[0].right.text = changed.join(String.fromCharCode(10));
 const exhausted = await reviewSnapshot(s, async () => ({ findings: [], limitations: [] }), { enableRetrieval: true, maxInputBytes: 8000, maxCalls: 2 });
 assert.equal(exhausted.modelCalls, 2); assert.equal(exhausted.files[0].windowCoverage.completed.length, 2);
 assert.equal(exhausted.files[0].synthesisStatus, 'pending'); assert.notEqual(exhausted.status, 'completed');
 const controller = new AbortController(); let firstSignal;
 const cancelled = await reviewSnapshot(s, async r => {
  firstSignal ??= r.signal; assert.equal(r.signal, firstSignal);
  if (JSON.parse(r.input).sourceMode === 'window-synthesis') { controller.abort(Error('stop synthesis')); throw r.signal.reason; }
  return { findings: [], limitations: [] };
 }, { enableRetrieval: true, maxInputBytes: 8000, signal: controller.signal });
 assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.files[0].windowCoverage.completed.length, 2);
 assert.equal(cancelled.files[0].synthesisStatus, 'pending');
 const found = await reviewSnapshot(s, async r => {
  if (JSON.parse(r.input).sourceMode !== 'window-synthesis') return { findings: [], limitations: [] };
  if (!JSON.parse(r.input).retrieved.length) return { requests: [{ kind: 'read', id: 's2', start: 11, count: 1 }, { kind: 'read', id: 's2', start: 81, count: 1 }] };
  return { findings: [{ fileId: 'f', severity: 'high', title: 'interaction', evidence: 'combined edits', trigger: 'both changes', impact: 'failure', suggestion: 'align', anchor: { kind: 'line', side: 'new', start: 11, end: 11, snippet: 'changed10' }, attribution: { editIds: ['e1', 'e2'], properties: [], beforeBehavior: 'aligned', afterBehavior: 'mismatch', reason: 'combined' } }], limitations: [] };
 }, { enableRetrieval: true, maxInputBytes: 8000 });
 assert.equal(found.findings.length, 1); assert.equal(found.files[0].synthesisStatus, 'completed');
});
test('synthesis retrieves both windows and verifies exact before-after receipts in shared budget', async () => {
 const s = snapshot(), lines = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
 s.files[0].left.text = lines.join(String.fromCharCode(10));
 const changed = [...lines]; changed[10] = 'changed10'; changed[80] = 'changed80'; s.files[0].right.text = changed.join(String.fromCharCode(10));
 let firstSignal;
 const report = await reviewSnapshot(s, async r => {
  firstSignal ??= r.signal; assert.equal(r.signal, firstSignal); const p = JSON.parse(r.input);
  if (p.candidates) {
   if (!p.retrieved.length) return { requests: [{ kind: 'read', id: 's1', start: 11, count: 1 }, { kind: 'read', id: 's2', start: 11, count: 1 }] };
   return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'old/new compared', evidence: p.retrieved.map(record => ({ receiptId: record.result.receiptId })), regression: { classification: 'introduced', reason: 'both changes break shared invariant', oldEvidence: [0], newEvidence: [1] } }] };
  }
  if (p.sourceMode !== 'window-synthesis') return { findings: [], limitations: [] };
  if (!p.retrieved.length) return { requests: [{ kind: 'read', id: 's2', start: 11, count: 1 }, { kind: 'read', id: 's2', start: 81, count: 1 }] };
  assert.equal(p.retrieved[1].result.text, 'changed80' + String.fromCharCode(10));
  return { findings: [{ fileId: 'f', severity: 'high', title: 'interaction', evidence: 'both changes', trigger: 'combined path', impact: 'failure', suggestion: 'align', anchor: { kind: 'line', side: 'new', start: 11, end: 11, snippet: 'changed10' }, attribution: { editIds: ['e1', 'e2'], properties: [], beforeBehavior: 'aligned', afterBehavior: 'broken', reason: 'combined edits' } }], limitations: [] };
 }, { enableRetrieval: true, enableVerification: true, maxInputBytes: 8000 });
 assert.equal(report.status, 'completed'); assert.equal(report.modelCalls, 6);
 assert.equal(report.files[0].synthesisStatus, 'completed');
 assert.equal(report.findings[0].verification.regression.classification, 'introduced');
 assert.equal(report.findings[0].verification.evidence.length, 2);
});
test('window cancellation and timeout await adapter cleanup and leave coverage pending', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const controller = new AbortController(); let cleaned = false, calls = 0;
    const report = await reviewSnapshot(snapshot(), async r => {
      calls++;
      const aborted = new Promise(resolve => r.signal.addEventListener('abort', resolve, { once: true }));
      if (mode === 'cancel') controller.abort(Error('cancel'));
      await aborted; cleaned = true; throw r.signal.reason;
    }, { enableRetrieval: true, maxInputBytes: 12000, signal: controller.signal, timeoutMs: 20 });
    assert.equal(cleaned, true); assert.equal(calls, 1);
    assert.equal(report.files[0].windowCoverage.completed.length, 0);
    assert.equal(report.files[0].windowCoverage.pending.length, 1);
    assert.equal(report.status, mode === 'cancel' ? 'cancelled' : 'failed');
  }
});
test('local deletion retains old-side anchor at original source line', async () => {
  const s = snapshot(); s.files[0].right.text = s.files[0].left.text.slice(0, -6);
  const report = await reviewSnapshot(s, async r => {
    const p = JSON.parse(r.input); assert.equal(p.sourceMode, 'change-windows');
    return { findings: [{ fileId: 'f', severity: 'medium', title: 'deleted protection', evidence: 'before removed', trigger: 'run', impact: 'failure', suggestion: 'restore', anchor: { kind: 'line', side: 'old', start: 2001, end: 2001, snippet: 'before' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'protected', afterBehavior: 'unprotected', reason: 'deleted' } }], limitations: [] };
  }, { enableRetrieval: true, maxInputBytes: 12000 });
  assert.equal(report.status, 'completed');
  assert.equal(report.findings[0].anchor.side, 'old');
});
test('no approved retrieval or window input still too large blocks without a send', async () => {
  for (const options of [{ maxInputBytes: 12000 }, { enableRetrieval: true, maxInputBytes: 10 }]) {
    const report = await reviewSnapshot(snapshot(), () => assert.fail('unexpected send'), options);
    assert.equal(report.files[0].status, 'blocked');
    assert.equal(report.files[0].windowCoverage, undefined);
  }
});
