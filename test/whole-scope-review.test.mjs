import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
import { reportSummaryData } from '../src/report-summary.mjs';
import { readabilityMarkdown } from '../src/report-readability.mjs';
import { modelWireBudget } from '../src/model-wire-budget.mjs';

const snapshot = (count = 2, body = 'unsafe();\n') => ({ id: 'whole-s', vcs: 'git', context: [], files: Array.from({ length: count }, (_, i) => ({ id: 'f' + i, path: 'file' + i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: body } })) });
const options = { validateFindingResponse: validateFindings };
const empty = input => ({ reviews: input.reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [] })), limitations: [] });
const candidate = (fileId, title = 'Guard removed') => ({ fileId, severity: 'high', title, evidence: 'unsafe operation', trigger: 'invalid state', impact: 'failure', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
const uncertain = input => ({ verdicts: input.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'uncertain', reason: 'Insufficient independent evidence', evidence: [] })) });

test('74 tiny complete members take one whole primary call without grouping risk or interaction calls', async () => {
  let calls = 0;
  const report = await reviewWholeScope(snapshot(74), request => {
    calls++; assert.equal(request.reviewPhase, 'group-primary');
    const input = JSON.parse(request.input); assert.equal(input.reviews.length, 74);
    assert.ok(input.reviews.every(row => row.file.right.text === 'unsafe();\n'));
    return empty(input);
  }, options);
  assert.equal(calls, 1); assert.equal(report.modelCalls, 1);
  assert.equal(report.coverage.completed, 74); assert.equal(report.status, 'completed');
  assert.equal(report.orchestration.primaryComplete, true); assert.deepEqual(report.interactions, []);
  assert.equal(reportSummaryData(report).complete, true); assert.ok(Array.isArray(readabilityMarkdown(report)));
});

test('candidates from different files share one verification call and retain original identities', async () => {
  const phases = [];
  const report = await reviewWholeScope(snapshot(3), request => {
    phases.push(request.reviewPhase); const input = JSON.parse(request.input);
    if (request.reviewPhase === 'verification') { assert.equal(input.candidates.length, 3); assert.equal(input.snapshotId, 'whole-s'); return uncertain(input); }
    const response = empty(input); response.reviews.forEach(row => { row.findings = [candidate(row.fileId)]; }); return response;
  }, options);
  assert.deepEqual(phases, ['group-primary', 'verification']); assert.equal(report.modelCalls, 2);
  assert.deepEqual(report.findings.map(f => f.fileId), ['f0', 'f1', 'f2']);
  assert.ok(report.findings.every(f => f.verification.status === 'completed' && f.verification.verdict === 'uncertain'));
  assert.equal(report.status, 'partial'); assert.ok(report.readerUsage.calls > 0);
});

test('more than 50 candidates are chunked globally, never one verification per file', async () => {
  const sizes = [];
  const report = await reviewWholeScope(snapshot(51), request => {
    const input = JSON.parse(request.input);
    if (request.reviewPhase === 'verification') { sizes.push(input.candidates.length); return uncertain(input); }
    const response = empty(input); response.reviews.forEach(row => { row.findings = [candidate(row.fileId)]; }); return response;
  }, { ...options, maxInputBytes: 512 * 1024 });
  assert.deepEqual(sizes, [50, 1]); assert.equal(report.modelCalls, 3); assert.equal(report.findings.length, 51);
});

test('oversized complete file is blocked without a model call or window fallback', async () => {
  const report = await reviewWholeScope(snapshot(1, 'x'.repeat(200000)), () => { throw new Error('must not call'); }, options);
  assert.equal(report.modelCalls, 0); assert.equal(report.coverage.blocked, 1); assert.equal(report.status, 'partial');
  assert.equal(report.orchestration.primaryComplete, false); assert.ok(report.files[0].requiredBytes > 98304);
});

for (const corruption of ['missing', 'duplicate', 'unknown']) test(corruption + ' whole member fails entire batch without publishing partial members', async () => {
  let calls = 0;
  const report = await reviewWholeScope(snapshot(), request => {
    calls++; const response = empty(JSON.parse(request.input));
    if (corruption === 'missing') response.reviews.pop();
    if (corruption === 'duplicate') response.reviews[1].fileId = response.reviews[0].fileId;
    if (corruption === 'unknown') response.reviews[1].fileId = 'foreign';
    return response;
  }, options);
  assert.equal(calls, 1); assert.equal(report.status, 'failed'); assert.equal(report.coverage.failed, 2);
  assert.equal(report.findings.length, 0); assert.equal(report.orchestration.primaryComplete, false);
});

test('cancel before invocation and during model execution cannot accept a final response', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(), reason = new Error('stop whole review'); let calls = 0;
    if (before) controller.abort(reason);
    const report = await reviewWholeScope(snapshot(), request => { calls++; controller.abort(reason); return empty(JSON.parse(request.input)); }, { ...options, signal: controller.signal });
    assert.equal(report.status, 'cancelled'); assert.equal(report.coverage.cancelled, 2); assert.equal(report.findings.length, 0);
    assert.equal(calls, before ? 0 : 1);
  }
});

test('maxCalls blocks candidate verification before fresh receipt reads, preserving candidates as incomplete', async () => {
  let calls = 0;
  const report = await reviewWholeScope(snapshot(), request => {
    calls++; const response = empty(JSON.parse(request.input)); response.reviews[0].findings = [candidate('f0')]; return response;
  }, { ...options, maxCalls: 1 });
  assert.equal(calls, 1); assert.equal(report.modelCalls, 1); assert.equal(report.status, 'partial');
  assert.equal(report.readerUsage.calls, 0); assert.equal(report.findings[0].verification.status, 'incomplete');
});

test('retrieval followups use the same maxCalls ledger and cannot silently complete exhausted primary', async () => {
  let calls = 0;
  const report = await reviewWholeScope(snapshot(), request => {
    calls++; const input = JSON.parse(request.input); return { requests: [{ kind: 'read', id: input.catalog[0].id, start: 1, count: 1 }] };
  }, { ...options, maxCalls: 1 });
  assert.equal(calls, 1); assert.equal(report.modelCalls, 1); assert.equal(report.coverage.pending, 2);
  assert.equal(report.status, 'partial'); assert.equal(report.orchestration.primaryComplete, false);
});

test('two byte batches preserve completed members but explicitly retain unreviewed cross-batch boundaries', async () => {
  const report = await reviewWholeScope(snapshot(2, 'unsafe();\n' + 'x'.repeat(30000)), request => empty(JSON.parse(request.input)), { ...options, maxInputBytes: 60000 });
  assert.equal(report.orchestration.batches.length, 2); assert.equal(report.modelCalls, 2);
  assert.equal(report.coverage.completed, 2); assert.equal(report.status, 'partial');
  assert.equal(report.orchestration.primaryComplete, false); assert.match(report.limitations.map(l => l.text).join(' '), /跨 batch/);
  assert.equal(reportSummaryData(report).complete, false);
});

test('anchor correction is opt-in and ordinary anchor identity and attribution validator remains authoritative', async () => {
  for (const enabled of [false, true]) {
    const s = snapshot(1); s.files[0].right.text = 'prefix();\nunsafe();\n';
    const report = await reviewWholeScope(s, request => {
      const input = JSON.parse(request.input); if (request.reviewPhase === 'verification') return uncertain(input);
      const response = empty(input); response.reviews[0].findings = [candidate('f0')]; return response;
    }, { ...options, enableAnchorCorrection: enabled });
    assert.equal(report.coverage.failed, enabled ? 0 : 1);
    if (enabled) assert.equal(report.findings[0].anchor.start, 2);
  }
});

test('verification can retrieve both sides in one batch but cannot use another primary file for regression', async () => {
  for (const foreign of [false, true]) {
    const report = await reviewWholeScope(snapshot(), request => {
      const input = JSON.parse(request.input);
      if (request.reviewPhase !== 'verification') {
        const response = empty(input); response.reviews.forEach(row => { row.findings = [candidate(row.fileId)]; }); return response;
      }
      const receipts = input.retrieved.filter(row => row.result.receiptId);
      const bySource = new Map(receipts.map(row => [row.result.sourceId, row.result.receiptId]));
      const missing = input.catalog.filter(source => !bySource.has(source.id));
      if (missing.length) return { requests: missing.map(source => ({ kind: 'read', id: source.id, start: 1, count: 1 })) };
      return { verdicts: input.candidates.map(c => {
        const owner = foreign ? 'f0' : c.finding.fileId;
        const old = input.catalog.find(source => source.fileId === owner && source.side === 'old');
        const fresh = input.catalog.find(source => source.fileId === owner && source.side === 'new');
        return { candidateId: c.candidateId, verdict: 'supported', reason: 'controlled comparison', evidence: [{ receiptId: bySource.get(old.id) }, { receiptId: bySource.get(fresh.id) }], regression: { classification: 'introduced', reason: 'controlled comparison', oldEvidence: [0], newEvidence: [1] } };
      }) };
    }, options);
    assert.equal(report.modelCalls, 3);
    assert.ok(report.findings.every(f => f.verification.status === (foreign ? 'incomplete' : 'completed')));
    if (foreign) assert.match(report.limitations.map(l => l.text).join(' '), /primary mismatch/);
    else assert.ok(report.findings.every(f => f.verification.regression.classification === 'introduced'));
  }
});

test('native outgoing requests fit actual wire budget and preserve business rules into verification', async () => {
  const s = snapshot(1); s.rules = [{ path: 'rules.txt', text: 'approved rule' }]; s.businessRequirement = 'untrusted requirement';
  const report = await reviewWholeScope(s, request => {
    assert.equal(request.nativeOutputTools, true); assert.ok(modelWireBudget(request, request.maxInputBytes).fits);
    const input = JSON.parse(request.input);
    if (request.reviewPhase === 'verification') { assert.deepEqual(input.rules, s.rules); assert.equal(input.businessRequirement, s.businessRequirement); return uncertain(input); }
    const response = empty(input); response.reviews[0].findings = [candidate('f0')]; return response;
  }, { ...options, nativeOutputTools: true });
  assert.equal(report.modelCalls, 2);
});

test('private artifact persistence failure remains fatal instead of false completion', async () => {
  await assert.rejects(reviewWholeScope(snapshot(1), async request => {
    await request.onModelArtifact({ kind: 'controlled' }); return empty(JSON.parse(request.input));
  }, { ...options, onModelArtifact: () => { throw new Error('disk failure'); } }), error => error.code === 'MODEL_ARTIFACT_FAILED');
});

test('metrics artifacts and correction callbacks share the global call ledger', async () => {
  const events = [], artifacts = [];
  const report = await reviewWholeScope(snapshot(1), async request => {
    await request.onProtocolCorrection({ jsonIssue: 'controlled' });
    await request.onModelEvent({ action: 'model-end', durationMs: 2, inputBytes: 20, totalOutputBytes: 30, callPurpose: 'json-correction' });
    await request.onModelArtifact({ kind: 'controlled' }); return empty(JSON.parse(request.input));
  }, { ...options, maxCalls: 2, onModelEvent: event => events.push(event), onModelArtifact: artifact => { artifacts.push(artifact); return { recorded: true }; } });
  assert.equal(report.modelCalls, 2); assert.equal(events.length, 1); assert.equal(artifacts[0].phase, 'group-primary');
  assert.equal(report.orchestration.modelMetrics['group-primary'].calls, 1); assert.equal(report.artifacts.length, 1);
});

test('whole-scope rejects direct multi-round and resume options before invoking the model', async () => {
  for (const extra of [{ reviewRounds: 2 }, { resumeState: { completed: [] } }]) {
    let calls = 0;
    await assert.rejects(reviewWholeScope(snapshot(), () => { calls++; }, { ...options, ...extra }), /fresh single-round/);
    assert.equal(calls, 0);
  }
});
test('cancellation retains accepted first batch and checkpoints before stopping the second', async () => {
  const controller = new AbortController(); let calls = 0; const saved = [];
  const report = await reviewWholeScope(snapshot(2, 'unsafe();' + String.fromCharCode(10) + 'x'.repeat(30000)), request => {
    calls++; if (calls === 2) controller.abort(new Error('stop'));
    return empty(JSON.parse(request.input));
  }, { ...options, signal: controller.signal, maxInputBytes: 60000, onResumeCheckpoint: async value => saved.push(value) });
  assert.equal(report.status, 'cancelled'); assert.equal(report.coverage.completed, 1); assert.equal(report.coverage.cancelled, 1);
  assert.ok(saved.length >= 2); assert.equal(saved.at(-1).status, 'cancelled');
});
test('checkpoint storage failure aborts instead of becoming an ordinary batch failure', async () => {
  const error = new Error('durable write failed');
  await assert.rejects(reviewWholeScope(snapshot(), request => empty(JSON.parse(request.input)), { ...options, onResumeCheckpoint: async () => { throw error; } }), value => value === error);
});
