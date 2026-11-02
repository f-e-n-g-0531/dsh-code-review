import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
import { buildResumeState, validateResumeState } from '../src/review-resume.mjs';

const input = () => ({ id: 'atomic-group-cache', vcs: 'git', context: [], files: ['a', 'b'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: 'unsafe();\n' } })) });
const opts = { enableRetrieval: true, enableBusinessGrouping: true, enableGroupPrimary: true, enableStageContinuation: true, enableVerification: true, optimizeReviewCalls: true, changesConcurrency: 1 };
const checkpointOptions = { route: { provider: 'offline', model: 'fixture' }, execution: { ...opts, rounds: 1 } };
const candidate = id => ({ fileId: id, severity: 'high', title: 'Removed guard ' + id, evidence: 'unsafe invocation', trigger: 'bad state', impact: 'invalid state', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unsafe', reason: 'guard removed' } });
const limits = (prefix, count) => Array.from({ length: count }, (_, i) => prefix + '-' + i);
function model({ member = 26, group = 25, host = false, property = false, seen = [] } = {}) {
  return request => {
    const p = JSON.parse(request.input); seen.push({ request, p });
    if (request.reviewPhase === 'verification') {
      if (!p.retrieved.some(item => item.result.receiptId)) return { requests: [{ kind: 'read', id: p.catalog.find(source => source.fileId === p.candidates[0].finding.fileId && source.side === 'new').id, start: 1, count: 1 }] };
      assert.ok(p.retrieved.some(item => item.result.receiptId), 'every final verifier receives a fresh scoped receipt');
      return { verdicts: p.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'refuted', reason: 'Independent counterevidence', evidence: [{ receiptId: p.retrieved.find(item => item.result.receiptId).result.receiptId }] })) };
    }
    if (p.sourceMode === 'file-interaction') return { findings: [], limitations: [] };
    assert.equal(p.sourceMode, 'group-primary');
    return { reviews: p.reviews.map(row => ({ fileId: row.fileId, findings: [{ ...candidate(row.fileId), ...(property && row.fileId === 'a' ? { anchor: { kind: 'property', name: 'unchanged' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unsafe', reason: 'changed call with property anchor' } } : {}) }], limitations: limits(row.fileId, member), ...(host ? {} : { risks: [] }) })), limitations: limits('group', group) };
  };
}

for (const [member, group, host, total] of [[26, 25, false, 51], [50, 50, true, 101]]) test('actual grouped model and host limitation union survives atomic stage cache and JSON checkpoint: ' + total, async () => {
  const s = input(), seen = [];
  const report = await reviewSnapshot(s, model({ member, group, host, seen }), { ...opts, enableRiskPlanning: host, maxCalls: 3 });
  assert.equal(seen.filter(row => row.p.sourceMode === 'group-primary').length, 1);
  assert.equal(seen.filter(row => row.request.reviewPhase === 'verification').length, 2);
  assert.equal(report.findings.length, 2); assert.ok(report.findings.every(f => f.verification.status === 'completed' && f.verification.verdict === 'refuted'));
  assert.deepEqual(report.files.map(file => file.fileId), ['a', 'b']); assert.ok(report.files.every(file => file.status === 'completed'));
  assert.equal(report.stageGenerations.length, 2); assert.ok(report.files.every(file => !file.stageCacheLimits));
  for (const record of report.stageGenerations) {
    assert.equal(record.generation.limitations.length, total);
    assert.deepEqual(record.generation.limitations.slice(0, member), limits(record.fileId, member));
    assert.deepEqual(record.generation.limitations.slice(member, member + group), limits('group', group));
    if (host) assert.match(record.generation.limitations.at(-1), /合并风险计划缺失或无效/);
  }
  assert.equal(report.interactions[0].status, 'pending');
  const saved = JSON.parse(JSON.stringify(buildResumeState(s, checkpointOptions, report)));
  assert.equal(saved.schemaVersion, 2); assert.equal(saved.completed.length, 0); assert.equal(saved.stageGenerations.length, 2);
  assert.deepEqual(validateResumeState(saved, s, checkpointOptions), saved);
  assert.ok(saved.stageGenerations.every(record => record.generation.limitations.length === total));
  assert.doesNotMatch(JSON.stringify(saved.stageGenerations), /receiptId|retrievalAudit|verification/);
});

test('one accepted group send is checkpointable under exhausted model calls and resume never regenerates primaries', async () => {
  const s = input(), firstSeen = [];
  const first = await reviewSnapshot(s, model({ seen: firstSeen }), { ...opts, maxCalls: 1 });
  assert.equal(first.modelCalls, 1); assert.equal(firstSeen.filter(row => row.p.sourceMode === 'group-primary').length, 1);
  assert.equal(firstSeen.filter(row => row.request.reviewPhase === 'verification').length, 0);
  assert.equal(first.stageGenerations.length, 2); assert.equal(first.interactions[0].status, 'pending'); assert.equal(first.status, 'partial');
  const saved = JSON.parse(JSON.stringify(buildResumeState(s, checkpointOptions, first)));
  validateResumeState(saved, s, checkpointOptions); assert.equal(saved.stageGenerations.length, 2);
  const resumedSeen = [], resumed = await reviewSnapshot(s, model({ seen: resumedSeen }), { ...opts, resumeState: saved });
  assert.equal(resumedSeen.filter(row => row.p.sourceMode === 'group-primary' || row.request.reviewPhase === 'primary').length, 0);
  assert.equal(resumedSeen.filter(row => row.request.reviewPhase === 'verification').length, 2);
  assert.equal(resumed.findings.length, 2); assert.ok(resumed.findings.every(f => f.verification.verdict === 'refuted'));
  assert.ok(resumed.files.every(file => file.status === 'completed')); assert.equal(resumed.interactions[0].status, 'completed');
  assert.equal(resumed.modelCalls, 3); assert.equal(resumed.retrievalUsage.calls, 4);
});

for (const overflow of ['member', 'group']) test('model ' + overflow + ' limitation 51 remains rejected before host cache merging', async () => {
  const seen = [], report = await reviewSnapshot(input(), model({ member: overflow === 'member' ? 51 : 1, group: overflow === 'group' ? 51 : 1, seen }), opts);
  assert.equal(seen.filter(row => row.p.sourceMode === 'group-primary').length, 1);
  assert.equal(seen.filter(row => row.request.reviewPhase === 'verification').length, 0);
  assert.equal(report.findings.length, 0); assert.equal(report.stageGenerations.length, 0);
  assert.ok(report.files.every(file => file.status === 'failed')); assert.equal(report.status, 'failed');
});

test('cache rejection with exhausted verifier calls keeps candidates incomplete without replaying primary or dropping later members', async () => {
  const s = input(); s.files[0].properties = [{ name: 'unchanged', old: 'same', new: 'same' }];
  const seen = [], report = await reviewSnapshot(s, model({ property: true, member: 1, group: 1, seen }), { ...opts, maxCalls: 1 });
  assert.equal(report.modelCalls, 1); assert.equal(seen.filter(row => row.p.sourceMode === 'group-primary').length, 1);
  assert.equal(seen.filter(row => row.request.reviewPhase === 'primary' || row.request.reviewPhase === 'verification').length, 0);
  assert.equal(report.findings.length, 2); assert.ok(report.findings.every(f => f.verification.status === 'incomplete'));
  assert.deepEqual(report.files.map(file => file.fileId), ['a', 'b']); assert.ok(report.files.every(file => file.status !== 'failed'));
  assert.equal(report.files[0].stageCacheLimits[0].code, 'STAGE_CACHE_RECORD_REJECTED'); assert.equal(report.files[1].stageCacheLimits, undefined);
  assert.deepEqual(report.stageGenerations.map(record => record.fileId), ['b']); assert.equal(report.interactions[0].status, 'pending'); assert.equal(report.status, 'partial');
  assert.ok(report.limitations.some(item => /MODEL_CALL|Model call|调用/.test(item.text)));
  const saved = JSON.parse(JSON.stringify(buildResumeState(s, checkpointOptions, report))); assert.deepEqual(validateResumeState(saved, s, checkpointOptions), saved);
});

test('checkpoint storage I/O failure keeps the exact error identity and never becomes a cache capacity limitation', async () => {
  const sentinel = Object.assign(new Error('offline checkpoint I/O failure'), { code: 'OFFLINE_CHECKPOINT_IO' }), seen = []; let callbacks = 0;
  await assert.rejects(reviewSnapshot(input(), model({ seen }), { ...opts, onResumeCheckpoint(report) { callbacks++; assert.equal(report.files[0].stageCacheLimits, undefined); assert.ok(report.stageGenerations.length > 0); throw sentinel; } }), error => error === sentinel);
  assert.equal(callbacks, 1); assert.equal(seen.filter(row => row.p.sourceMode === 'group-primary').length, 1);
});

test('cancellation after accepted group verification retains the original reason instead of cache fallback', async () => {
  const controller = new AbortController(), reason = Object.assign(new Error('offline caller cancellation'), { code: 'OFFLINE_CANCELLED' }), seen = []; let callbacks = 0;
  const report = await reviewSnapshot(input(), model({ seen }), { ...opts, signal: controller.signal, onResumeCheckpoint(report) { callbacks++; assert.ok(report.stageGenerations.length > 0); controller.abort(reason); } });
  assert.ok(callbacks >= 1); assert.equal(controller.signal.reason, reason); assert.equal(report.status, 'cancelled');
  assert.equal(seen.filter(row => row.p.sourceMode === 'group-primary').length, 1); assert.equal(seen.filter(row => row.request.reviewPhase === 'verification').length, 1);
  assert.ok(report.files.every(file => !file.stageCacheLimits)); assert.ok(report.files.some(file => file.status !== 'completed'));
  assert.equal(report.interactions[0].status, 'pending'); assert.equal(report.files.some(file => file.resumeEligible), false);
});

test('a rejected stage record is explicit and cannot poison later valid members or suppress current candidate verification', async () => {
  const s = input(); s.files[0].properties = [{ name: 'unchanged', old: 'same', new: 'same' }];
  const seen = [], report = await reviewSnapshot(s, model({ property: true, member: 1, group: 1, seen }), opts);
  assert.equal(seen.filter(row => row.p.sourceMode === 'group-primary').length, 1);
  assert.equal(seen.filter(row => row.request.reviewPhase === 'verification').length, 3);
  assert.equal(report.findings.length, 2); assert.ok(report.findings.every(f => f.verification.status === 'completed'));
  assert.deepEqual(report.files.map(file => file.status), ['completed', 'completed']);
  const rejected = report.files.find(file => file.fileId === 'a'); assert.equal(rejected.stageCacheLimits.length, 1); assert.equal(rejected.stageCacheLimits[0].code, 'STAGE_CACHE_RECORD_REJECTED');
  assert.equal(report.files.find(file => file.fileId === 'b').stageCacheLimits, undefined);
  assert.deepEqual(report.stageGenerations.map(record => record.fileId), ['b']); assert.equal(report.status, 'partial');
  assert.ok(report.limitations.some(item => /缓存|cache|检查点/.test(item.text)));
  const saved = JSON.parse(JSON.stringify(buildResumeState(s, checkpointOptions, report))); assert.ok(saved.stageGenerations.every(record => record.fileId !== 'a'));
  assert.deepEqual(validateResumeState(saved, s, checkpointOptions), saved);
});
