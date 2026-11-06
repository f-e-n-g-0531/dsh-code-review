import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
import { reviewSnapshot } from '../src/review.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
const snapshot = () => ({ id: 'policy-snapshot', root: '/repo', vcs: 'git', context: [], files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'new();' } }] });
const exec = () => ({ agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'fixture', model: 'offline' } }, signal: new AbortController().signal });
function fixture(config = {}) {
  const inputs = [];
  const service = createReviewService({ async *stream(options) {
    const p = JSON.parse(options.messages[0].content[0].text); inputs.push(p);
    const value = p.candidates ? { verdicts: p.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'uncertain', reason: 'No semantic proof', evidence: [] })) } : p.reviews ? { reviews: p.reviews.map(r => ({ fileId: r.fileId, findings: [], limitations: [] })), limitations: [] } : { findings: [], limitations: [] };
    yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => true, ...config });
  return { service, inputs };
}

test('comparison is explicit host construction policy, default off and request overrides rejected', async t => {
  for (const enabled of [undefined, false, true]) {
    const f = fixture(enabled === undefined ? {} : { enableModelComparison: enabled }); t.after(() => f.service.dispose());
    const e = exec(), p = await f.service.preview({}, e);
    assert.equal(p.execution.enableModelComparison, enabled === true);
    assert.equal(f.inputs.length, 0);
    if (enabled) assert.match(p.notice, /关系由模型判断.*不证明语义迁移或因果/);
    await assert.rejects(f.service.preview({ enableModelComparison: true }, e), /Unknown preview/);
    await assert.rejects(f.service.execute({ previewId: p.previewId, confirmed: true, enableModelComparison: false }, e), /Confirmed preview/);
    const result = await f.service.execute({ previewId: p.previewId, confirmed: true }, e);
    assert.equal(result.report.execution.enableModelComparison, enabled === true);
  }
  for (const value of [null, 1, 'true']) assert.throws(() => fixture({ enableModelComparison: value }), /comparison policy/);
});

test('preview policy is captured and comparison changes invalidate staged resume identity', async t => {
  let saved;
  const config = { enableModelComparison: true }, f = fixture(config); t.after(() => f.service.dispose());
  config.enableModelComparison = false;
  const e = exec(); e.reviewResumeCheckpoint = async value => { saved = structuredClone(value); };
  const p = await f.service.preview({}, e); assert.equal(p.execution.enableModelComparison, true);
  await f.service.execute({ previewId: p.previewId, confirmed: true }, e); assert.ok(saved);
  e.resolveReviewResume = async () => saved;
  const same = fixture({ enableModelComparison: true }), changed = fixture({ enableModelComparison: false });
  t.after(() => same.service.dispose()); t.after(() => changed.service.dispose());
  const args = { resumeFromJobId: '11111111-1111-1111-1111-111111111111' };
  assert.equal((await same.service.preview(args, e)).execution.enableModelComparison, true);
  await assert.rejects(changed.service.preview(args, e), /identity mismatch/);
});

test('both staged and whole-scope baseline and independent counter verifications receive explicit policy', async () => {
  const finding = { fileId: 'f', severity: 'high', title: 'candidate', evidence: 'new();', trigger: 'static', impact: 'static', suggestion: 'check', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'new();' } };
  for (const executionStrategy of ['staged', 'whole-scope']) for (const enabled of [false, true]) {
    let comparisons = 0;
    const report = await reviewSnapshot(snapshot(), request => {
      const p = JSON.parse(request.input);
      if (p.candidates) {
        comparisons++; assert.equal(p.modelComparisonPolicy?.enabled === true, enabled);
        const ref = { receiptId: p.retrieved[0].result.receiptId };
        return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'Exact local evidence', evidence: [ref] }] };
      }
      return p.reviews ? { reviews: [{ fileId: 'f', findings: [finding], limitations: [] }], limitations: [] } : { findings: [finding], limitations: [] };
    }, { executionStrategy, enableModelComparison: enabled, enableRetrieval: true, enableVerification: true, enableCounterVerification: true, maxInputBytes: 100000 });
    assert.equal(comparisons, 2, executionStrategy + ' baseline plus independent counter');
    assert.equal(report.findings.length, 1);
  }
});

test('project review does not accidentally inherit changes-only comparison policy', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comparison-project-')); t.after(() => rm(root, { recursive: true, force: true }));
  await checked('git', ['init', '-q'], { cwd: root }); await writeFile(path.join(root, 'a.js'), 'const value = 1;'); await checked('git', ['add', 'a.js'], { cwd: root });
  const f = fixture({ enableModelComparison: true }); t.after(() => f.service.dispose());
  const e = exec(); e.agent.session.header.cwd = root;
  const p = await f.service.preview({ reviewMode: 'project' }, e);
  assert.notEqual(p.execution.enableModelComparison, true);
  const result = await f.service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.ok(f.inputs.every(input => input.modelComparisonPolicy === undefined));
  assert.notEqual(result.report.execution?.enableModelComparison, true);
});
