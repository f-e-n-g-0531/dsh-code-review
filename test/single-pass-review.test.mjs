import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSinglePass } from '../src/single-pass-review.mjs';
import { validateResponse, markdownReport } from '../src/review.mjs';
import { changeMap } from '../src/change-map.mjs';
import { reportSummaryData } from '../src/report-summary.mjs';
import { renderUserReport } from '../src/user-report.mjs';

const snapshot = (count = 2) => ({ id: 'single-s', vcs: 'git', context: [], rules: [], files: Array.from({ length: count }, (_, i) => ({ id: 'f' + i, path: 'file' + i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n', exists: true }, right: { text: 'unsafe();\n', exists: true } })) });
const options = { validateFindingResponse: validateResponse };
const empty = request => ({ reviews: JSON.parse(request.input).reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [], completion: { status: 'completed', gaps: [] }, assuranceNotes: [] })), limitations: [], completion: { status: 'completed', gaps: [] }, assuranceNotes: [] });
const candidate = fileId => ({ fileId, severity: 'high', title: 'Guard removed', evidence: 'unsafe operation', trigger: 'invalid state', impact: 'failure', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
const invariant = report => { assert.equal(Object.entries(report.coverage).filter(([key]) => key !== 'total').reduce((sum, [, count]) => sum + count, 0), report.coverage.total); assert.ok(report.modelCalls <= 1); };

test('35 complete files share exactly one logical invocation, with full text and original scope', async () => {
  const source = snapshot(35), frozen = structuredClone(source); let calls = 0;
  const report = await reviewSinglePass(source, request => {
    calls++; assert.equal(request.sourceMode, 'single-pass'); assert.equal(request.reviewPhase, 'single-pass'); assert.equal(request.strictSingleCall, true);
    const input = JSON.parse(request.input); assert.equal(input.reviews.length, 35);
    for (const row of input.reviews) { assert.equal(input.contents[row.file.right.textRef], 'unsafe();\n'); assert.equal(input.contents[row.file.left.textRef], 'guard();\n'); }
    return empty(request);
  }, options);
  assert.equal(calls, 1); assert.equal(report.modelCalls, 1); assert.equal(report.status, 'completed'); assert.equal(report.coverage.completed, 35);
  assert.equal(report.orchestration.primaryComplete, true); assert.equal(report.orchestration.independentVerification, false); assert.deepEqual(source, frozen); invariant(report);
});

for (const candidates of [[], [{ path: 'clients/use.js', status: 'captured' }]]) test('bounded successful caller discovery stays completed across report layers (' + candidates.length + ' candidates)', async () => {
  const source = snapshot(1);
  source.callerDiscovery = { incomplete: true, scopes: ['clients'], candidates };
  const report = await reviewSinglePass(source, empty, options);
  assert.equal(report.status, 'completed');
  assert.equal(report.orchestration.captureComplete, true);
  assert.equal(report.orchestration.primaryComplete, true);
  assert.equal(reportSummaryData(report).complete, true);
  assert.equal(report.modelCalls, 1);
  for (const text of [markdownReport(report), renderUserReport(report)]) {
    assert.match(text, /约定静态审核完成/);
    assert.doesNotMatch(text, /不完整验收失败/);
    assert.match(text, /调用方|caller/);
  }
});

test('caller truncation cannot be promoted by completed model declarations', async () => {
  const source = snapshot(1);
  source.callerDiscovery = { incomplete: true, truncated: true, scopes: ['clients'], candidates: [] };
  const report = await reviewSinglePass(source, empty, options);
  assert.equal(report.status, 'partial');
  assert.equal(report.orchestration.captureComplete, false);
  assert.equal(report.orchestration.primaryComplete, false);
  assert.equal(reportSummaryData(report).complete, false);
  assert.match(renderUserReport(report), /不完整验收失败/);
});

test('global limitations are preserved once rather than copied to every member', async () => {
  const report = await reviewSinglePass(snapshot(35), request => { const result = empty(request); result.limitations = ['Global dependency missing']; result.reviews[0].limitations = ['Member-only constraint']; return result; }, options);
  assert.equal(report.limitations.filter(item => item.text === 'Global dependency missing').length, 1);
  assert.equal(report.limitations.find(item => item.text === 'Global dependency missing').fileId, undefined);
  assert.equal(report.limitations.find(item => item.text === 'Member-only constraint').fileId, 'f0');
  assert.equal(report.status, 'partial'); assert.equal(report.modelCalls, 1); invariant(report);
});

test('candidates are deterministic validated only, never promoted to supported', async () => {
  const report = await reviewSinglePass(snapshot(), request => { const result = empty(request); result.reviews[0].findings = [{ ...candidate('f0'), verification: { status: 'completed', verdict: 'supported' } }]; return result; }, options);
  assert.equal(report.findings.length, 1); assert.deepEqual(report.findings[0].verification, { status: 'not-requested', method: 'single-pass-model', causality: 'model-assessed' });
  assert.deepEqual(report.execution, { executionStrategy: 'single-pass', assurance: { level: 'single-model', independentVerification: false } });
  assert.deepEqual(report.executionAssurance, { mode: 'single-pass', independentVerification: false, protocolValid: true });
  assert.deepEqual(report.findings[0].validation, { schema: 'validated', identity: 'validated', anchor: 'exact-snapshot' });
  assert.equal(report.findings[0].attribution.causality, 'unverified'); assert.ok(markdownReport(report).includes('单次')); invariant(report);
});

for (const corrupt of ['json', 'schema', 'missing', 'duplicate', 'unknown', 'finding-identity', 'severity', 'interaction', 'requests', 'oversized']) test(corrupt + ' rejects whole generation atomically without retry', async () => {
  let calls = 0;
  const report = await reviewSinglePass(snapshot(35), request => {
    calls++; const result = empty(request); result.reviews[0].findings = [candidate('f0')];
    if (corrupt === 'json') return '{ PRIVATE_BAD_JSON';
    if (corrupt === 'oversized') return ' '.repeat(128 * 1024) + JSON.stringify(result);
    if (corrupt === 'schema') result.reviews[1].limitations = null;
    if (corrupt === 'missing') result.reviews.pop();
    if (corrupt === 'duplicate') result.reviews[1].fileId = 'f0';
    if (corrupt === 'unknown') result.reviews[1].fileId = 'foreign';
    if (corrupt === 'finding-identity') result.reviews[1].findings = [candidate('f0')];
    if (corrupt === 'severity') result.reviews[0].findings[0].severity = 'PRIVATE_ERROR';
    if (corrupt === 'interaction') result.reviews[0].findings[0].interaction = {};
    if (corrupt === 'requests') result.requests = [];
    return result;
  }, options);
  assert.equal(calls, 1); assert.equal(report.status, 'failed'); assert.equal(report.coverage.failed, 35); assert.equal(report.findings.length, 0); assert.equal(report.orchestration.protocolValid, false); assert.equal(report.orchestration.primaryComplete, false); assert.ok(!JSON.stringify(report).includes('PRIVATE_')); invariant(report);
});

test('exact anchor mismatch isolates entire bad member and never publishes its other findings', async () => {
  const report = await reviewSinglePass(snapshot(), request => { const result = empty(request); result.reviews[0].findings = [candidate('f0')]; const bad = candidate('f1'); bad.anchor.snippet = 'wrong'; result.reviews[1].findings = [candidate('f1'), bad]; return result; }, options);
  assert.equal(report.coverage.completed, 1); assert.equal(report.coverage.failed, 1); assert.equal(report.files[1].failureCode, 'MODEL_ANCHOR_MISMATCH'); assert.deepEqual(report.findings.map(f => f.fileId), ['f0']); invariant(report);
});

test('deleted old-side and changed property anchors retain original source and change map', async () => {
  const source = snapshot(); source.vcs = 'svn'; source.files[0].right = { text: '', exists: false }; source.files[1].properties = [{ name: 'svn:executable', old: null, new: '*' }];
  const seen = [];
  const report = await reviewSinglePass(source, request => { const result = empty(request); const old = candidate('f0'); old.anchor = { kind: 'line', side: 'old', start: 1, end: 1, snippet: 'guard();' }; const property = candidate('f1'); property.anchor = { kind: 'property', name: 'svn:executable' }; property.attribution.editIds = []; property.attribution.properties = ['svn:executable']; result.reviews[0].findings = [old]; result.reviews[1].findings = [property]; return result; }, { ...options, validateFindingResponse: (value, file, changes) => { seen.push([file, changes]); return validateResponse(value, file, changes); } });
  assert.equal(report.findings.length, 2); assert.equal(seen[0][0].right.exists, false); assert.equal(seen[0][0].left.text, source.files[0].left.text); assert.ok(seen[0][1].edits.length); invariant(report);
});

test('real strict attribution rejects invented edits unchanged properties and missing explanation atomically', async () => {
  for (const invalid of ['edit', 'property', 'explanation']) {
    const source = snapshot(); source.files[0].properties = [{ name: 'svn:executable', old: '*', new: '*' }];
    const report = await reviewSinglePass(source, request => { const result = empty(request); const finding = candidate('f0'); if (invalid === 'edit') finding.attribution.editIds = ['fake']; if (invalid === 'property') { finding.attribution.editIds = []; finding.attribution.properties = ['svn:executable']; } if (invalid === 'explanation') finding.attribution.beforeBehavior = ''; result.reviews[0].findings = [finding]; return result; }, options);
    assert.equal(report.status, 'failed'); assert.equal(report.coverage.failed, 2); assert.equal(report.findings.length, 0); assert.equal(report.executionAssurance.protocolValid, false); invariant(report);
  }
});

test('limited diff never accepts invented exact edit attribution from transport or snapshot caches', async () => {
  const source = snapshot(1); source.files[0].left.text = Array.from({ length: 500 }, (_, i) => 'old' + i).join('\n'); source.files[0].right.text = Array.from({ length: 500 }, (_, i) => 'new' + i).join('\n');
  assert.equal(changeMap(source.files[0].left.text, source.files[0].right.text).status, 'limited');
  source.files[0].changes = { status: 'changed', edits: [{ id: 'e1' }] };
  const report = await reviewSinglePass(source, request => { const result = empty(request); assert.equal(JSON.parse(request.input).reviews[0].changes.status, 'limited'); const finding = candidate('f0'); finding.anchor.snippet = 'new0'; result.reviews[0].findings = [finding]; return result; }, options);
  assert.equal(report.status, 'failed'); assert.equal(report.findings.length, 0); invariant(report);
});

test('original side hashes and full property old/new metadata reach strict validation unchanged', async () => {
  const source = snapshot(1), file = source.files[0]; file.left.hash = 'original-old-byte-hash'; file.right.hash = 'original-new-byte-hash'; file.properties = [{ name: 'svn:executable', old: null, new: '*', oldHash: 'old-property-hash', newHash: 'new-property-hash' }];
  let validated = false;
  const report = await reviewSinglePass(source, request => { const projected = JSON.parse(request.input).reviews[0]; assert.equal(projected.file.left.hash, file.left.hash); assert.equal(projected.file.right.hash, file.right.hash); assert.deepEqual(projected.file.properties, file.properties); const result = empty(request); result.reviews[0].findings = [candidate('f0')]; return result; }, { ...options, validateFindingResponse: (response, original, changes) => { assert.deepEqual(original, file); assert.deepEqual(changes, changeMap(file.left.text, file.right.text)); validated = true; return validateResponse(response, original, changes); } });
  assert.equal(validated, true); assert.equal(report.findings[0].attribution.status, 'references-validated'); assert.equal(report.findings[0].attribution.causality, 'unverified'); invariant(report);
});

test('zero reviewable preserves excluded and blocked scope with zero calls', async () => {
  const source = snapshot(); source.files[0].eligibility = 'excluded'; source.files[1].eligibility = 'blocked';
  const report = await reviewSinglePass(source, () => assert.fail('no model'), options); assert.equal(report.modelCalls, 0); assert.equal(report.coverage.excluded, 1); assert.equal(report.coverage.blocked, 1); invariant(report);
});

test('complete prepared budget is atomic and cannot focus, split, or raise root cap', async () => {
  const source = snapshot(35); source.files[0].right.text = 'unique '.repeat(4000);
  const opts = { ...options, maxInputBytes: 10000 };
  const report = await reviewSinglePass(source, () => assert.fail('over cap'), opts);
  assert.equal(opts.maxInputBytes, 10000); assert.equal(report.coverage.blocked, 35); assert.equal(report.modelCalls, 0); assert.equal(report.orchestration.batches.length, 1); assert.equal(report.orchestration.input.scopeCount, 35); invariant(report);
});

for (const boundary of ['before', 'admission', 'model', 'validator', 'checkpoint']) test('cancellation wins at ' + boundary, async () => {
  const controller = new AbortController(); let calls = 0, checkpoints = 0;
  if (boundary === 'before') controller.abort(new Error('PRIVATE_CANCEL'));
  const report = await reviewSinglePass(snapshot(), request => { calls++; if (boundary === 'model') controller.abort(); return empty(request); }, { ...options, signal: controller.signal, beforeCall: () => { if (boundary === 'admission') controller.abort(); }, validateFindingResponse: (...args) => { if (boundary === 'validator') controller.abort(); return validateResponse(...args); }, onResumeCheckpoint: () => { checkpoints++; if (boundary === 'checkpoint' && checkpoints === 2) { controller.abort(); throw new Error('PRIVATE_CHECKPOINT'); } } });
  assert.equal(calls, ['before', 'admission'].includes(boundary) ? 0 : 1); assert.equal(report.status, 'cancelled'); assert.equal(report.findings.length, 0); assert.equal(report.coverage.cancelled, 2); assert.ok(!JSON.stringify(report).includes('PRIVATE')); invariant(report);
});

test('checkpoint failures propagate safely before or after invocation without replay', async () => {
  for (const failAt of [1, 2]) { let calls = 0, count = 0; await assert.rejects(reviewSinglePass(snapshot(), request => { calls++; return empty(request); }, { ...options, onResumeCheckpoint: () => { if (++count === failAt) throw new Error('PRIVATE_STORAGE'); } }), error => error.code === 'SINGLE_PASS_CHECKPOINT_FAILED' && !error.message.includes('PRIVATE')); assert.equal(calls, failAt - 1); }
});

test('output exception and model exception never resend and have fixed safe diagnostic', async () => {
  for (const output of [true, false]) { let calls = 0; const report = await reviewSinglePass(snapshot(), request => { calls++; if (!output) throw new Error('PRIVATE_PROVIDER'); return empty(request); }, { ...options, onProgress: () => { if (output) throw new Error('PRIVATE_OUTPUT'); } }); assert.equal(calls, 1); assert.equal(report.modelCalls, 1); assert.equal(report.status, 'failed'); assert.equal(report.coverage.failed, 2); assert.ok(!JSON.stringify(report).includes('PRIVATE')); invariant(report); }
});

test('beforeCall, remainingCalls and physical dispatch counters conserve admission', async () => {
  let admissions = 0, queries = 0, sends = 0;
  const report = await reviewSinglePass(snapshot(), async request => { assert.equal(request.remainingCalls(), 1); await request.beforeSend(); sends++; assert.equal(request.remainingCalls(), 0); await assert.rejects(request.beforeSend(), { code: 'SINGLE_PASS_CALL_LIMIT' }); await assert.rejects(request.onProtocolCorrection({}), { code: 'SINGLE_PASS_EXTRA_CALL' }); return empty(request); }, { ...options, remainingCalls: () => { queries++; return 1 - admissions; }, beforeCall: () => { admissions++; } });
  assert.equal(admissions, 1); assert.equal(queries, 1); assert.equal(sends, 1); assert.equal(report.modelCalls, 1); invariant(report);
  for (const denied of [{ maxCalls: 0 }, { remainingCalls: () => 0 }, { beforeCall: () => false }]) { const blocked = await reviewSinglePass(snapshot(), () => assert.fail('denied'), { ...options, ...denied }); assert.equal(blocked.modelCalls, 0); assert.equal(blocked.coverage.blocked, 2); invariant(blocked); }
});

test('actual metrics come only from provider events with missing values null and wrapper wall separate', async () => {
  for (const events of [false, true]) { const report = await reviewSinglePass(snapshot(), async request => { if (events) await request.onModelEvent({ action: 'model-end', durationMs: 17, inputBytes: 31 }); return empty(request); }, options); const timing = report.orchestration.executionShape.modelRequests[0]; assert.equal(timing.durationMs, events ? 17 : null); assert.equal(timing.totalOutputBytes, null); assert.equal(timing.metricsObserved, events); assert.ok(timing.wrapperDurationMs >= 0); invariant(report); }
});

test('source boundary never sends excluded bodies or secret paths; unapproved context fails closed', async () => {
  const source = snapshot(3); source.files[1].eligibility = 'excluded'; source.files[1].right.text = 'PRIVATE_EXCLUDED'; source.files[2].path = '.env'; source.files[2].right.text = 'PRIVATE_SECRET';
  const report = await reviewSinglePass(source, request => { assert.ok(!request.input.includes('PRIVATE_')); assert.equal(JSON.parse(request.input).reviews.length, 1); return empty(request); }, options); assert.equal(report.coverage.total, 3); assert.equal(report.coverage.excluded, 1); assert.equal(report.coverage.blocked, 1); invariant(report);
  source.context = [{ path: source.files[1].path, text: 'PRIVATE_CONTEXT' }]; const denied = await reviewSinglePass(source, () => assert.fail('unapproved context'), options); assert.equal(denied.modelCalls, 0); assert.equal(denied.coverage.total, 3); assert.ok(!JSON.stringify(denied).includes('PRIVATE_'));
});

for (const gap of ['truncated', 'auto-blocked', 'caller-blocked']) test('host capture gap ' + gap + ' remains partial despite empty model limitations', async () => {
  const source = snapshot(1);
  const candidate = { path: 'src/uncaptured.js', fromPath: 'src/uncaptured.js', targetPath: 'file0.js', status: 'blocked', reason: 'PRIVATE_UNKNOWN_REASON', text: 'PRIVATE_UNAPPROVED_BODY' };
  if (gap === 'truncated') source.autoContext = { truncated: true, candidates: [], text: 'PRIVATE_UNAPPROVED_BODY' };
  if (gap === 'auto-blocked') source.autoContext = { truncated: false, candidates: [candidate] };
  if (gap === 'caller-blocked') source.callerDiscovery = { scopes: ['src'], incomplete: true, candidates: [candidate], scanned: [], capturedPaths: [], text: 'PRIVATE_UNAPPROVED_BODY' };
  let calls = 0;
  const report = await reviewSinglePass(source, request => { calls++; const payload = JSON.parse(request.input); const capture = gap === 'caller-blocked' ? payload.captureStatus.callerDiscovery : payload.captureStatus.autoContext; assert.ok(capture); if (gap === 'truncated') assert.equal(capture.truncated, true); else assert.equal(capture.candidates[0].status, 'blocked'); assert.ok(!request.input.includes('PRIVATE_')); return empty(request); }, options);
  assert.equal(calls, 1); assert.equal(report.modelCalls, 1); assert.equal(report.status, 'partial'); assert.equal(report.orchestration.primaryComplete, false); assert.equal(report.orchestration.captureComplete, false); assert.equal(reportSummaryData(report).complete, false); assert.ok(report.limitations.some(item => item.code === (gap === 'truncated' ? 'SINGLE_PASS_AUTO_CONTEXT_TRUNCATED' : gap === 'auto-blocked' ? 'SINGLE_PASS_AUTO_CONTEXT_BLOCKED' : 'SINGLE_PASS_CALLER_CONTEXT_BLOCKED'))); assert.ok(report.captureStatus); assert.ok(!JSON.stringify(report).includes('PRIVATE_')); invariant(report);
});

test('project multi-round and resume modes reject without calls', async () => {
  for (const forbidden of [{ reviewRounds: 2 }, { resumeState: {} }, { resumeFromJobId: 'old' }, { reviewMode: 'project' }]) await assert.rejects(reviewSinglePass(snapshot(), () => assert.fail('forbidden'), { ...options, ...forbidden }), { code: 'SINGLE_PASS_INVALID_MODE' });
  const source = snapshot(); source.projectScope = {}; await assert.rejects(reviewSinglePass(source, () => assert.fail('project'), options), { code: 'SINGLE_PASS_INVALID_MODE' });
});
