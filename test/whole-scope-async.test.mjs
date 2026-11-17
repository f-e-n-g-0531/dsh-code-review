import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
import { createWholeVerificationQueue } from '../src/whole-verification-queue.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const snapshot = (count = 3, large = true) => ({ id: 'async-s', vcs: 'git', context: [], files: Array.from({ length: count }, (_, i) => ({ id: 'f' + i, path: 'file' + i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: 'unsafe();\n' + (large ? 'x'.repeat(30000) : '') } })) });
const finding = fileId => ({ fileId, severity: 'high', title: 'Guard removed', evidence: 'unsafe operation', trigger: 'invalid state', impact: 'failure', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
const primary = input => ({ reviews: input.reviews.map(row => ({ fileId: row.fileId, findings: [finding(row.fileId), finding(row.fileId)], limitations: [] })), limitations: [] });
const verdict = input => ({ verdicts: input.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'uncertain', reason: 'Controlled evidence does not establish causality', evidence: [] })) });
const options = { enableAsyncVerification: true, verificationConcurrency: 2, maxInputBytes: 60000, validateFindingResponse: validateFindings };

test('accepted primary overlaps controlled verifier with later primary; exact dedup and root budgets conserved', async () => {
 const verifierStarted = deferred(), laterPrimary = deferred();
 const order = [], verified = [];
 const report = await reviewWholeScope(snapshot(), async request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'group-primary') {
   const id = input.reviews[0].fileId; order.push('primary:' + id);
   if (id === 'f1') { laterPrimary.resolve(); await verifierStarted.promise; }
   return primary(input);
  }
  await laterPrimary.promise; verified.push(input.candidates[0].finding.fileId); verifierStarted.resolve();
  return verdict(input);
 }, options);
 assert.deepEqual(verified, ['f0', 'f1', 'f2']);
 assert.deepEqual(report.findings.map(f => f.fileId), ['f0', 'f1', 'f2']);
 assert.ok(report.findings.every(f => f.primaryOrigins.length >= 1));
 assert.equal(report.modelCalls, 6); assert.ok(report.readerUsage.calls <= report.readerBudget.maxCalls);
 assert.equal(report.readerBudget.maxCalls, 50); assert.equal(report.readerBudget.maxOutputBytes, 256 * 1024);
 assert.equal(report.readerAllocation.releasedUnits, 2);
 assert.equal(report.orchestration.executionShape.modelRequests.length, 6);
 assert.ok(report.orchestration.executionShape.modelRequests.every(r => r.attempt >= 1 && r.durationMs === null && r.wrapperDurationMs >= 0 && r.inputBytes === null));
});

test('verification concurrency bounded and final report joins held work; no candidate facts mutated', async () => {
 const held = deferred(), twoStarted = deferred(); let active = 0, peak = 0, started = 0, finished = false;
 const run = reviewWholeScope(snapshot(4, false), async request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'group-primary') return primary(input);
  assert.equal(input.candidates.length, 1); assert.equal(input.candidates[0].finding.primaryOrigins, undefined);
  const frozen = JSON.stringify(input.candidates); peak = Math.max(peak, ++active); if (++started === 2) twoStarted.resolve();
  await held.promise; assert.equal(JSON.stringify(input.candidates), frozen); active--; return verdict(input);
 }, options).then(value => { finished = true; return value; });
 await twoStarted.promise; await tick(); assert.equal(peak, 2); assert.equal(started, 2); assert.equal(finished, false);
 held.resolve(); const report = await run; assert.equal(active, 0); assert.equal(report.findings.length, 4); assert.equal(peak, 2);
});

test('cancellation joins primary child cleanup and in-flight verification before returning', async () => {
 const controller = new AbortController(), verifying = deferred(), cleanup = deferred(), verifierEnd = deferred();
 let primaryCount = 0, disposed = 0, settled = false;
 const run = reviewWholeScope(snapshot(2), async request => {
  const input = JSON.parse(request.input); verifying.resolve(); await verifierEnd.promise; return verdict(input);
 }, { ...options, signal: controller.signal, createBatchModel: async () => ({
  invoke: async request => { const input = JSON.parse(request.input); if (++primaryCount === 2) await verifying.promise; return primary(input); },
  dispose: async () => { disposed++; if (disposed === 2) await cleanup.promise; },
 }) }).then(report => { settled = true; return report; });
 await verifying.promise; controller.abort(new Error('stop')); await tick(); assert.equal(settled, false);
 verifierEnd.resolve(); await tick(); assert.equal(settled, false); cleanup.resolve();
 const report = await run; assert.equal(report.status, 'cancelled'); assert.equal(disposed, 2);
});

test('checkpoint failure aborts and joins independently held verifier', async () => {
 const verifying = deferred(), held = deferred(); let checks = 0, settled = false;
 const run = reviewWholeScope(snapshot(2), async request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'group-primary') { if (input.reviews[0].fileId === 'f1') await verifying.promise; return primary(input); }
  verifying.resolve(); await held.promise; return verdict(input);
 }, { ...options, onResumeCheckpoint: () => { if (++checks === 2) throw new Error('checkpoint unavailable'); } });
 const observed = run.then(() => { settled = true; }, error => { settled = true; return error; });
 await verifying.promise; await tick(); assert.equal(settled, false); held.resolve();
 assert.match((await observed).message, /checkpoint unavailable/);
});

test('fresh receipt from first file cannot authorize another verification stage', async () => {
 let receipt;
 const report = await reviewWholeScope(snapshot(2, false), request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'group-primary') return primary(input);
  const own = input.retrieved.find(r => r.result.receiptId).result.receiptId;
  receipt ??= own;
  return { verdicts: input.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'uncertain', reason: 'foreign reference rejected', evidence: [{ receiptId: receipt }] })) };
 }, { ...options, verificationConcurrency: 1 });
 assert.equal(report.findings[0].verification.status, 'completed');
 assert.equal(report.findings[1].verification.status, 'incomplete');
 assert.equal(report.orchestration.verifications[1].failureCode, 'INVALID_EVIDENCE_RECEIPT');
});

test('member isolation publishes good row, keeps bad row failed and mixed stage partial', async () => {
 const report = await reviewWholeScope(snapshot(2, false), request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'verification') return verdict(input);
  const result = primary(input); result.reviews[1].findings[0].anchor.snippet = 'not approved'; return result;
 }, { ...options, enableMemberIsolation: true, enableInvestigationState: true, relationAwareGrouping: true, primaryInputMode: 'full' });
 assert.equal(report.files[0].status, 'completed'); assert.equal(report.files[1].status, 'failed');
 assert.equal(report.files[1].failureCode, 'MODEL_ANCHOR_MISMATCH');
 assert.equal(report.orchestration.batches[0].status, 'partial'); assert.equal(report.status, 'partial');
 assert.deepEqual(report.findings.map(f => f.fileId), ['f0']);
});

test('queue lanes serialize a reader, permit peers, and drain joins cleanup after failure', async () => {
 const held = deferred(), started = deferred(); let active = 0, peak = 0, count = 0;
 const queue = createWholeVerificationQueue(async value => { peak = Math.max(peak, ++active); if (++count === 2) started.resolve(); try { await held.promise; if (value === 1) throw new Error('fatal'); } finally { active--; } }, { concurrency: 4 });
 queue.enqueue(1, 'a'); queue.enqueue(2, 'a'); queue.enqueue(3, 'b');
 await started.promise; assert.equal(count, 2); assert.equal(peak, 2); held.resolve();
 await assert.rejects(queue.drain(), /fatal/); assert.equal(active, 0); assert.equal(count, 2);
});

test('async policy rejects malformed bounds before models', async () => {
 for (const verificationConcurrency of [0, 5, 1.5]) await assert.rejects(reviewWholeScope(snapshot(), () => {}, { ...options, verificationConcurrency }), /verificationConcurrency/);
 await assert.rejects(reviewWholeScope(snapshot(), () => {}, { ...options, enableAsyncVerification: 'yes' }), /enableAsyncVerification/);
});

test('all new policies integrate with focused original-coordinate validation and fresh receipts', async () => {
 const report = await reviewWholeScope(snapshot(2, false), request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'group-primary') {
   assert.equal(input.primaryInputMode, 'focused');
   assert.ok(input.reviews.every(row => row.file.right.text === undefined));
   return primary(input);
  }
  return verdict(input);
 }, { ...options, enableMemberIsolation: true, relationAwareGrouping: true, primaryInputMode: 'focused', enableInvestigationState: true });
 assert.equal(report.coverage.completed, 2); assert.equal(report.findings.length, 2);
 assert.match(report.scopeNotices[0].text, /未送全文/); assert.ok(report.orchestration.grouping.groups.length > 0);
 assert.ok(report.findings.every(f => f.verification.status === 'completed'));
});

test('artifact failure in async verifier aborts and joins all admitted primary cleanup', async () => {
 const verifying = deferred(), cleanup = deferred(); let disposed = 0, settled = false;
 const run = reviewWholeScope(snapshot(2), async request => {
  verifying.resolve(); await request.onModelArtifact({}); return verdict(JSON.parse(request.input));
 }, { ...options, onModelArtifact: () => { throw new Error('artifact store'); }, createBatchModel: async () => ({
  invoke: async request => { const input = JSON.parse(request.input); if (input.reviews[0].fileId === 'f1') await verifying.promise; return primary(input); },
  dispose: async () => { if (++disposed === 2) await cleanup.promise; },
 }) });
 const observed = run.then(() => { settled = true; }, error => { settled = true; return error; });
 await verifying.promise; await tick(); assert.equal(settled, false); cleanup.resolve();
 assert.equal((await observed).code, 'MODEL_ARTIFACT_FAILED'); assert.equal(disposed, 2);
});

test('async budget veto never launches free verification or resets root allowance', async () => {
 let verified = 0;
 const report = await reviewWholeScope(snapshot(2, false), request => {
  const input = JSON.parse(request.input); if (request.reviewPhase === 'group-primary') return primary(input);
  verified++; return verdict(input);
 }, { ...options, maxCalls: 1 });
 assert.equal(verified, 0); assert.equal(report.modelCalls, 1); assert.equal(report.readerUsage.calls, 0);
 assert.ok(report.findings.every(f => f.verification.status === 'incomplete'));
 assert.equal(report.readerBudget.maxCalls, 50);
});

test('capacity parent exact candidates wait for terminal leaves and retain stable origins once', async () => {
 const source = snapshot(5); source.files.forEach(file => { file.right.text = 'unsafe();\n' + 'x'.repeat(18000); });
 const terminal = new Set(), verified = new Set();
 const report = await reviewWholeScope(source, request => {
  const input = JSON.parse(request.input);
  for (const item of input.candidates) { assert.ok(terminal.has(item.finding.fileId)); assert.ok(!verified.has(item.finding.fileId)); verified.add(item.finding.fileId); }
  return verdict(input);
 }, { ...options, maxInputBytes: 98304, nativeOutputTools: true, wholeScopeConcurrency: 1, createBatchModel: async ({ fileIds }) => ({
  transport: 'host-subagent', childId: fileIds.join(','), dispose: async () => {}, runPrimary: async args => {
   args.reserveModelCall(); const result = primary(JSON.parse(args.request.input));
   if (fileIds.length > 1) { args.onCapacityFinalOnly({}); args.onBudgetLimited({ code: 'CHILD_FOLLOWUP_CAPACITY' }); }
   else terminal.add(fileIds[0]);
   return result;
  },
 }) });
 assert.equal(verified.size, 5); assert.equal(report.findings.length, 5);
 assert.ok(report.findings.some(f => f.primaryOrigins.length > 1));
 const hostRows = report.orchestration.executionShape.modelRequests.filter(row => row.status === 'host-admitted-unobserved');
 assert.ok(hostRows.length > 0); assert.ok(hostRows.every(row => row.startedAt === null && row.durationMs === null && row.inputBytes === null));
});


test('finished terminal A releases unused floor before B verifier starts while later primary is still live', async () => {
 const aVerified = deferred(), keepPrimary = deferred(); let aBudget, bBudget, bReads = 0;
 const source = snapshot(3);
 const report = await reviewWholeScope(source, async request => {
  const input = JSON.parse(request.input);
  if (request.reviewPhase === 'group-primary') {
   const id = input.reviews[0].fileId;
   if (id === 'f2') await keepPrimary.promise;
   return primary(input);
  }
  const id = input.candidates[0].finding.fileId;
  if (id === 'f0') { aBudget = input.retrievalBudget.remainingCalls; aVerified.resolve(); return verdict(input); }
  if (id === 'f1') {
   await aVerified.promise;
   bBudget ??= input.retrievalBudget.remainingCalls;
   if (++bReads <= 6) return { requests: [{ kind: 'read', id: input.catalog.find(s => s.fileId === 'f1' && s.side === 'old').id, start: 1, count: 1 }] };
   keepPrimary.resolve();
  }
  return verdict(input);
 }, { ...options, verificationConcurrency: 1, maxVerificationRetrievalRounds: 8 });
 assert.ok(bBudget > aBudget, 'released A floor must be available to B before primary pool release');
 assert.ok(bReads >= 7); assert.equal(report.findings[1].verification.status, 'completed');
});


test('failed isolated capacity leaf retains and verifies accepted parent candidate before floor release', async () => {
 const source = snapshot(5); source.files.forEach(file => { file.right.text = 'unsafe();\n' + 'x'.repeat(18000); });
 const parentCandidateFiles = new Set(), failedLeaves = new Set(), verified = new Map();
 const report = await reviewWholeScope(source, request => {
  const input = JSON.parse(request.input);
  for (const item of input.candidates) {
   const id = item.finding.fileId;
   assert.ok(failedLeaves.has(id));
   assert.equal(item.finding.anchor.snippet, 'unsafe();');
   verified.set(id, (verified.get(id) ?? 0) + 1);
  }
  return verdict(input);
 }, { ...options, enableMemberIsolation: true, maxInputBytes: 98304, nativeOutputTools: true, wholeScopeConcurrency: 1,
  createBatchModel: async ({ fileIds }) => ({ transport: 'host-subagent', childId: fileIds.join(','), dispose: async () => {}, runPrimary: async args => {
   args.reserveModelCall(); const result = primary(JSON.parse(args.request.input));
   if (fileIds.length > 1) {
    args.onCapacityFinalOnly({}); args.onBudgetLimited({ code: 'CHILD_FOLLOWUP_CAPACITY' });
    fileIds.forEach(id => parentCandidateFiles.add(id));
   } else {
    failedLeaves.add(fileIds[0]);
    result.reviews[0].findings[0].anchor.snippet = 'not approved';
   }
   return result;
  } }),
 });
 assert.ok(parentCandidateFiles.size > 0);
 for (const id of parentCandidateFiles) {
  const state = report.files.find(file => file.fileId === id);
  assert.equal(state.status, 'failed'); assert.equal(state.failureCode, 'MODEL_ANCHOR_MISMATCH');
  const candidates = report.findings.filter(finding => finding.fileId === id);
  assert.equal(candidates.length, 1); assert.ok(candidates[0].primaryOrigins.every(origin => origin.limited));
  assert.equal(candidates[0].verification.status, 'completed'); assert.equal(verified.get(id), 1);
 }
 assert.equal(report.status, 'failed');
 assert.equal(report.orchestration.asyncVerification.readerAllocation.releasedUnits, 5);
});
