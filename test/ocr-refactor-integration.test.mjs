import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
import { createReviewService } from '../src/service.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createEvidenceContext } from '../src/evidence-context.mjs';
import { retrievalLoop } from '../src/retrieval-loop.mjs';

const snapshot = () => ({ id: 'ocr-integration', vcs: 'git', root: '/repo', context: [], files: ['src/a.js', 'test/a.test.js'].map((path, i) => ({ id: 'f' + i, path, eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: 'unsafe();\n' }, rightExists: true })) });
const base = { enableRetrieval: true, enableGrouping: true, enableRiskPlanning: true, skipSmallRiskPlans: false, riskPlanningMode: 'auto', optimizeReviewCalls: true, enablePrimarySeeds: false, enableVerification: true, maxRetrievalRounds: 3 };
const empty = () => ({ findings: [], limitations: [], risks: [] });
const interactionFinding = () => ({ fileId: 'f1', severity: 'high', title: 'Synthetic contract mismatch', evidence: 'Two changed guards', trigger: 'Missing input', impact: 'Invalid state', suggestion: 'Align both guards', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'Both edits participate' }, interaction: { editRefs: [{ fileId: 'f0', editId: 'e1' }, { fileId: 'f1', editId: 'e1' }] } });

async function run({ enableEvidenceContext = false, inlineInteractionRisks = false, riskMode = 'valid', maxCalls, forgeReceipt = false } = {}) {
  const seen = [];
  const report = await reviewSnapshot(snapshot(), request => {
    const p = JSON.parse(request.input); seen.push({ request, p });
    if (request.reviewPhase === 'risk-planning') return { risks: [] };
    if (request.reviewPhase === 'verification') {
      assert.ok(p.retrieved.length, 'verifier obtains evidence under its own reader');
      assert.ok(p.retrieved.every(item => typeof item.result.receiptId === 'string'));
      return { verdicts: p.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'refuted', reason: 'Synthetic independent counterevidence', evidence: [{ receiptId: forgeReceipt ? 'foreign-prior-stage-receipt' : p.retrieved[0].result.receiptId }] })) };
    }
    const sources = p.catalog.filter(s => s.side === 'new' && ['f0', 'f1'].includes(s.fileId));
    if (p.file?.id === 'f0') {
      if (!p.retrieved.length) return { requests: sources.map(s => ({ kind: 'read', id: s.id, start: 1, count: 1 })) };
      return empty();
    }
    if (p.file) return empty();
    assert.equal(p.sourceMode, 'file-interaction');
    const missing = sources.filter(s => !p.retrieved.some(item => item.result.sourceId === s.id));
    if (missing.length) return { requests: missing.map(s => ({ kind: 'read', id: s.id, start: 1, count: 1 })) };
    for (const item of p.retrieved) { assert.equal(item.result.snapshotId, 'ocr-integration'); assert.equal(item.result.text, 'unsafe();\n'); assert.equal(item.result.receiptId, undefined); }
    return { findings: [interactionFinding()], limitations: [], ...(riskMode === 'missing' ? {} : { risks: riskMode === 'invalid' ? [{ bad: true }] : [] }) };
  }, { ...base, enableEvidenceContext, inlineInteractionRisks, ...(maxCalls === undefined ? {} : { maxCalls }) });
  return { report, seen };
}

const interactionTurns = seen => seen.filter(({ request, p }) => p.sourceMode === 'file-interaction' && request.reviewPhase !== 'risk-planning');

test('actual review calls distinguish independent evidence redelivery and inline interaction planning reductions', async () => {
  const bothOff = await run(), evidenceOnly = await run({ enableEvidenceContext: true }), inlineOnly = await run({ inlineInteractionRisks: true }), bothOn = await run({ enableEvidenceContext: true, inlineInteractionRisks: true });
  assert.deepEqual([bothOff.report.modelCalls, evidenceOnly.report.modelCalls, inlineOnly.report.modelCalls, bothOn.report.modelCalls], [7, 6, 6, 5]);
  for (const result of [bothOff, evidenceOnly, inlineOnly, bothOn]) {
    assert.equal(result.report.status, 'completed'); assert.equal(result.report.interactions[0].status, 'completed');
    assert.deepEqual(result.report.findings, bothOff.report.findings);
    assert.deepEqual(result.report.coverage, bothOff.report.coverage);
    assert.equal(result.report.findings[0].verification.verdict, 'refuted');
    assert.equal(result.report.findings[0].interaction.causality, 'unverified');
    assert.equal(result.report.readerBudget.maxCalls, 50);
  }
  assert.equal(interactionTurns(bothOff.seen).length, 2); assert.equal(interactionTurns(bothOn.seen).length, 1);
  assert.deepEqual(interactionTurns(bothOff.seen)[0].p.retrieved, []);
  const delivered = interactionTurns(bothOn.seen)[0].p.retrieved;
  assert.deepEqual(new Set(delivered.map(item => item.result.sourceId)), new Set(['s2', 's4']));
  assert.ok(bothOn.report.retrievalUsage.cacheHits >= 2, 'redelivery reuses materialization but not prompt bytes');
  const owner = bothOn.report.files.find(file => file.fileId === 'f1');
  assert.equal(owner.retrievalAudit.filter(item => item.stage === 'retrieved-locally' && ['s2', 's4'].includes(item.sourceId)).length >= 2, true);
  const bytes = bothOn.seen.filter(({ request }) => request.reviewPhase !== 'risk-planning').flatMap(({ p }) => p.retrieved).reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item.result)), 0);
  assert.ok(bothOn.report.retrievalUsage.outputBytes >= bytes, 'every fresh delivery and subsequent validation is metered');
  const verifier = bothOn.seen.find(({ request }) => request.reviewPhase === 'verification');
  assert.notEqual(verifier.p.retrieved[0].result.receiptId, undefined);
  assert.equal(delivered.some(item => item.result.receiptId), false);
});

for (const [riskMode, status] of [['missing', 'absent'], ['invalid', 'invalid']]) test('optional ' + riskMode + ' interaction risks preserve findings without hidden planning or correction', async () => {
  const { report, seen } = await run({ enableEvidenceContext: true, inlineInteractionRisks: true, riskMode });
  assert.equal(report.findings.length, 1); assert.equal(report.findings[0].verification.verdict, 'refuted');
  assert.equal(report.modelCalls, 5); assert.equal(seen.filter(({ request }) => request.reviewPhase === 'risk-planning').length, 0);
  assert.equal(report.interactions[0].status, 'completed'); assert.equal(report.status, 'partial');
  const owner = report.files.find(file => file.fileId === 'f1');
  const plan = owner.riskPlans.find(plan => plan.sourceMode === 'file-interaction');
  assert.equal(plan.method, 'inline'); assert.equal(plan.status, status); assert.equal(owner.responseCorrections, undefined);
});

test('foreign evidence receipts fail independently and a saved body does not turn limited review into completion', async () => {
  const forged = await run({ enableEvidenceContext: true, inlineInteractionRisks: true, forgeReceipt: true });
  assert.equal(forged.report.findings[0].verification.status, 'incomplete'); assert.equal(forged.report.status, 'partial');
  assert.notEqual(forged.report.findings[0].verification.verdict, 'supported');
  const limited = await run({ enableEvidenceContext: true, inlineInteractionRisks: true, maxCalls: 3 });
  assert.equal(limited.report.modelCalls, 3); assert.equal(limited.report.status, 'partial');
  assert.equal(limited.report.interactions[0].status, 'pending'); assert.equal(limited.report.findings.length, 0);
  assert.equal(interactionTurns(limited.seen).length, 0, 'no stage evidence is credited without a stage send');
});

test('service preview execution and resume bind both explicit OCR options and retain low-level off defaults', async t => {
  const exec = { agent: { session: { header: { id: 'ocr-owner', cwd: '/repo' } }, options: { provider: 'offline', model: 'fake' } }, signal: new AbortController().signal };
  let calls = 0, saved;
  const llm = { async *stream() { calls++; yield { type: 'text-delta', text: JSON.stringify(empty()) }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const settings = { capture: async () => snapshot(), allowModelSending: true, authorize: async () => true, ...base, changesConcurrency: 1 };
  const on = createReviewService(llm, { ...settings, enableEvidenceContext: true, inlineInteractionRisks: true }); t.after(() => on.dispose());
  exec.reviewResumeCheckpoint = async state => { saved = state; };
  const preview = await on.preview({}, exec);
  assert.equal(calls, 0); assert.equal(preview.execution.enableEvidenceContext, true); assert.equal(preview.execution.inlineInteractionRisks, true); assert.equal(preview.plan.minimumCalls, 3);
  const { report } = await on.execute({ previewId: preview.previewId, confirmed: true }, exec);
  assert.equal(report.modelCalls, 3); assert.equal(calls, 3); assert.equal(saved.completed.length, 2);
  exec.resolveReviewResume = async () => saved;
  const resumeArgs = { resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const resumed = await on.preview(resumeArgs, exec);
  const replay = await on.execute({ previewId: resumed.previewId, confirmed: true }, exec);
  assert.equal(replay.report.modelCalls, 0); assert.equal(calls, 3); assert.equal(replay.report.resume.reusedFiles, 2);
  for (const flag of ['enableEvidenceContext', 'inlineInteractionRisks']) {
    const changed = createReviewService(llm, { ...settings, enableEvidenceContext: true, inlineInteractionRisks: true, [flag]: false }); t.after(() => changed.dispose());
    await assert.rejects(changed.preview(resumeArgs, exec), /identity mismatch/);
  }
  const off = createReviewService(llm, settings); t.after(() => off.dispose());
  const old = await off.preview({}, exec);
  assert.equal(old.execution.enableEvidenceContext, false); assert.equal(old.execution.inlineInteractionRisks, false); assert.equal(old.plan.minimumCalls, 4);
});

test('actual refuted and limited reviews put cautious conclusions and findings before coverage details', async () => {
  const completed = await run({ enableEvidenceContext: true, inlineInteractionRisks: true });
  const markdown = markdownReport(completed.report);
  const summary = markdown.indexOf('## 结论摘要'), findings = markdown.indexOf('## 审查发现'), coverage = markdown.indexOf('## 覆盖情况');
  assert.ok(summary >= 0 && summary < findings && findings < coverage);
  assert.doesNotMatch(markdown.slice(summary, findings), /复核支持本次新增 [1-9]/);
  assert.match(markdown.slice(summary, findings), /复核反驳 1/);
  assert.ok(markdown.indexOf('Synthetic contract mismatch') < coverage);
  const limited = await run({ enableEvidenceContext: true, inlineInteractionRisks: true, maxCalls: 3 });
  const limitedMarkdown = markdownReport(limited.report);
  const headline = limitedMarkdown.slice(limitedMarkdown.indexOf('## 结论摘要'), limitedMarkdown.indexOf('## 审查发现'));
  assert.match(headline, /尚未查完（部分完成）/); assert.match(headline, /跨文件综合：完成 0.1 项；未完成 1 项/);
  assert.match(headline, /不得据此放行/);
  assert.equal(limited.report.interactions[0].status, 'pending');
});

test('known model-call admission veto spends no optional context replay bytes or audit', async () => {
  const input = snapshot(), scope = createRetrievalScope(input, { reuseResults: true }), context = createEvidenceContext(input.id);
  const operation = { kind: 'read', id: 's2', start: 1, count: 1 }, result = scope.read(operation);
  context.remember([{ kind: 'read', snapshotId: input.id, sourceId: result.sourceId, hash: result.hash, start: result.start, count: result.count }]);
  assert.equal(context.size(), 1);
  const before = scope.usage(), audits = []; let sends = 0, producers = 0;
  const request = { instructions: 'Review approved sources', input: JSON.stringify({ snapshotId: input.id, sourceMode: 'file-interaction', files: [{ fileId: 'f0' }, { fileId: 'f1' }] }) };
  const veto = new Error('Known model call budget exhausted');
  await assert.rejects(retrievalLoop(() => { sends++; return empty(); }, request, scope, {
    beforeCall() { throw veto; },
    initialContext(existing, buildRequest) { producers++; return context.seed(scope, request, { sourceIds: ['s2'], existing, buildRequest }); },
    onRetrieved(records) { audits.push(...records); },
  }), error => error === veto);
  assert.equal(producers, 0); assert.equal(sends, 0); assert.deepEqual(audits, []); assert.deepEqual(scope.usage(), before);
  let admitted;
  await retrievalLoop(actual => { admitted = JSON.parse(actual.input); return empty(); }, request, scope, {
    initialContext: (existing, buildRequest) => context.seed(scope, request, { sourceIds: ['s2'], existing, buildRequest }),
    onRetrieved: records => audits.push(...records),
  });
  assert.equal(admitted.retrieved.length, 1); assert.equal(admitted.retrieved[0].result.text, 'unsafe();\n');
  assert.equal(scope.usage().calls, before.calls); assert.equal(scope.usage().cacheHits, before.cacheHits + 1);
  assert.equal(scope.usage().outputBytes - before.outputBytes, Buffer.byteLength(JSON.stringify(admitted.retrieved[0].result)));
  assert.equal(audits.length, 1);
});

test('actual grouped primary selects deferred context through nested member relations', async () => {
  async function grouped(enableEvidenceContext) {
    const input = snapshot();
    input.files.unshift({ ...structuredClone(input.files[0]), id: 'warm', path: 'warmup.js' });
    input.files[1].left.text = 'import { Helper } from "../dep.js";\nguard();\n';
    input.files[1].right.text = 'import { Helper } from "../dep.js";\nunsafe();\n';
    input.context = [{ path: 'dep.js', text: 'export function Helper() {}\n' + '// approved filler\n'.repeat(1200) }];
    const seen = [];
    const report = await reviewSnapshot(input, request => {
      const p = JSON.parse(request.input); seen.push({ request, p });
      const source = p.catalog.find(item => item.path === 'dep.js');
      if (p.file?.id === 'warm') {
        if (!p.retrieved.length) return { requests: [{ kind: 'read', id: source.id, start: 1, count: 1 }] };
        return empty();
      }
      if (p.sourceMode === 'group-primary') {
        assert.equal(p.contextRelations, undefined); assert.deepEqual(p.context, []);
        assert.ok(p.reviews.some(member => member.contextRelations?.some(relation => relation.toPath === 'dep.js')));
        if (!p.retrieved.length) return { requests: [{ kind: 'read', id: source.id, start: 1, count: 1 }] };
        assert.equal(p.retrieved[0].result.sourceId, source.id); assert.equal(p.retrieved[0].result.text, 'export function Helper() {}\n');
        assert.equal(p.retrieved[0].result.receiptId, undefined);
        return { reviews: p.reviews.map(member => ({ fileId: member.fileId, findings: [], limitations: [] })), limitations: [] };
      }
      assert.equal(p.sourceMode, 'file-interaction'); return empty();
    }, { ...base, enableRiskPlanning: false, enableVerification: false, enableGroupPrimary: true, focusPrimaryContext: true, enableEvidenceContext, changesConcurrency: 1 });
    return { report, seen };
  }
  const off = await grouped(false), on = await grouped(true);
  assert.equal(off.report.primaryGroups.length, 1); assert.deepEqual(off.report.primaryGroups, on.report.primaryGroups);
  assert.equal(off.seen.filter(item => item.p.sourceMode === 'group-primary').length, 2);
  assert.equal(on.seen.filter(item => item.p.sourceMode === 'group-primary').length, 1);
  assert.equal(off.report.modelCalls - on.report.modelCalls, 1); assert.equal(on.report.status, 'partial'); assert.equal(off.report.status, 'partial');
  assert.ok(on.report.files.every(file => file.status === 'completed')); assert.ok(on.report.interactions.every(item => item.status === 'completed'));
  assert.ok(on.report.limitations.every(item => item.text.includes('其他批准全文须按需读取')));
  assert.deepEqual(on.report.coverage, off.report.coverage); assert.deepEqual(on.report.findings, off.report.findings);
  assert.ok(on.report.orchestration.retrievalAudit.some(item => item.sourceId === on.seen.find(item => item.p.sourceMode === 'group-primary').p.catalog.find(source => source.path === 'dep.js').id));
});

for (const flag of ['enableEvidenceContext', 'inlineInteractionRisks']) test(flag + ' rejects non-boolean policy rather than silently changing execution', async () => {
  await assert.rejects(reviewSnapshot(snapshot(), () => empty(), { ...base, [flag]: 'true' }), /Invalid review optimization option/);
  const service = createReviewService({}, { capture: async () => snapshot(), [flag]: 'true' });
  try { await assert.rejects(service.preview({}, { agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'offline', model: 'fake' } }, signal: new AbortController().signal }), /Invalid review optimization option/); }
  finally { service.dispose(); }
});
