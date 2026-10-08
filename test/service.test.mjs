import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
const snapshot = () => ({ id: 'fixed', vcs: 'git', root: '/repo', files: [{ id: 'f', path: 'a', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }], context: [] });
const exec = () => ({ agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'test', model: 'model' } }, signal: new AbortController().signal });
test('rule selection is previewed and authorized before sending', async () => {
  let approved = false, calls = 0;
  const rule = { path: 'rules.md', hash: 'fixture-hash', text: 'RULE_TEXT' };
  const service = createReviewService({ async *stream(r) {
    assert.ok(approved); calls++;
    assert.equal(JSON.parse(r.messages[0].content[0].text).rules[0].text, 'RULE_TEXT');
    yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { capture: async (_cwd, opts) => {
    assert.deepEqual(opts.rulePaths, ['rules.md']);
    return { ...snapshot(), rules: [rule] };
  }, allowModelSending: true, authorize: async ({ snapshot: s }) => {
    assert.equal(s.rules[0].hash, rule.hash); approved = true; return true;
  } });
  const e = exec(), p = await service.preview({ rulePaths: ['rules.md'] }, e);
  assert.equal(calls, 0); assert.equal(p.plan.minimumCalls, 1); assert.equal(p.plan.items[0].status, 'ready'); assert.ok(!JSON.stringify(p.plan).includes('RULE_TEXT')); assert.deepEqual(p.rules, [{ path: rule.path, hash: rule.hash }]);
  assert.match(p.notice, /规则全文/);
  const result = await service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.equal(calls, 1); assert.equal(result.report.files[0].initialInputBytes, p.plan.items[0].initialInputBytes); assert.deepEqual(result.report.rules, p.rules);
  assert.match(result.markdown, /fixture-hash/);
  assert.ok(!result.markdown.includes('RULE_TEXT'));
});
const llm = { async *stream() { yield { type: 'text-delta', text: '{"findings":[],"limitations":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
test('approved service verifies candidates without executable tools or widened scope', async () => {
  let approved = false, calls = 0;
  const service = createReviewService({ async *stream(r) {
    assert.ok(approved); assert.deepEqual(r.tools, []);
    const input = JSON.parse(r.messages[0].content[0].text);
    calls++;
    const output = calls === 1 ? { findings: [{ fileId: 'f', severity: 'high', title: 'Candidate', evidence: 'e', trigger: 't', impact: 'i', suggestion: 's', anchor: { kind: 'file' } }], limitations: [] }
      : { verdicts: [{ candidateId: input.candidates[0].candidateId, verdict: 'uncertain', reason: 'Missing caller', evidence: [] }] };
    if (calls === 2) assert.deepEqual(input.catalog.map(s => s.id), ['s1', 's2']);
    yield { type: 'text-delta', text: JSON.stringify(output) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => { approved = true; return true; } });
  const e = exec(), p = await service.preview({}, e);
  assert.equal(calls, 0); assert.match(p.notice, /证据与反证复核/);
  const { report, markdown } = await service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.equal(calls, 2); assert.equal(report.modelCalls, 2);
  assert.equal(report.findings[0].verification.verdict, 'uncertain');
  assert.match(markdown, /复核状态：不确定/);
});
test('approved service supplies both related sides once per primary without excluded content', async () => {
  const source = snapshot();
  source.files = ['src/a.ts', 'test/a.test.ts'].map((path, i) => ({ ...source.files[0], id: 'f' + i, path }));
  source.files.push({ id: 'secret', path: 'secret.ts', eligibility: 'excluded', left: { text: 'SECRET' }, right: { text: 'SECRET' } });
  let approved = false; const seen = [];
  const service = createReviewService({ async *stream(r) {
    assert.ok(approved); assert.deepEqual(r.tools, []);
    const p = JSON.parse(r.messages[0].content[0].text);
    if (p.sourceMode === 'file-interaction') {
      assert.ok(!r.messages[0].content[0].text.includes('SECRET'));
      yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    seen.push(p.file.id); assert.equal(p.relatedFiles.length, 1);
    assert.equal(p.relatedFiles[0].left.text, 'old');
    assert.ok(!r.messages[0].content[0].text.includes('SECRET'));
    yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { capture: async () => source, allowModelSending: true, authorize: async () => { approved = true; return true; } });
  const e = exec(), p = await service.preview({}, e);
  assert.equal(seen.length, 0);
  const { report } = await service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.deepEqual(seen, ['f0', 'f1']); assert.equal(report.modelCalls, 3);
  assert.equal(report.interactions[0].status, 'completed');
  assert.equal(report.coverage.excluded, 1); assert.equal(report.status, 'completed');
});

test('approved host stream performs retrieval round trip and propagates truncation', async () => {
  let approved = false, calls = 0;
  const model = { async *stream(request) {
    assert.equal(approved, true);
    assert.deepEqual(request.tools, []);
    const input = JSON.parse(request.messages[0].content[0].text);
    calls++;
    if (calls === 2) {
      assert.equal(input.retrieved[0].result.truncated, true);
      assert.equal(input.retrieved[0].result.matches[0].sourceId, 's3');
    }
    const output = calls === 1 ? { requests: [{ kind: 'search', query: 'match', limit: 1 }] } : { findings: [], limitations: [] };
    yield { type: 'text-delta', text: JSON.stringify(output) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const service = createReviewService(model, { capture: async () => ({ ...snapshot(), context: [{ path: 'helper', text: 'match\nmatch\n' }] }), allowModelSending: true, authorize: async () => { approved = true; return true; } });
  const e = exec(), preview = await service.preview({}, e);
  assert.equal(calls, 0); assert.match(preview.notice, /多轮只读检索/);
  const { report, markdown } = await service.execute({ previewId: preview.previewId, confirmed: true }, e);
  assert.equal(report.status, 'partial'); assert.equal(report.modelCalls, 2);
  assert.equal(report.retrievalUsage.calls, 1);
  assert.match(markdown, /部分匹配未提供/);
});

test('preview does not call model; confirmed execution returns report', async () => {
  const service = createReviewService(llm, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => true });
  const e = exec(), p = await service.preview({}, e);
  assert.equal(p.model.provider, 'test');
  const result = await service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.equal(result.report.status, 'completed'); assert.equal(result.report.outdated, false);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /Preview/);
});
test('foreign owner, changed cwd, expired preview and unconfirmed execution fail', async () => {
  let time = 0;
  const service = createReviewService(llm, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => true, now: () => time });
  const e = exec(), p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, exec()), /owner/);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: false }, e), /Confirmed/);
  e.agent.session.header.cwd = '/other';
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /directory/);
  e.agent.session.header.cwd = '/repo'; time = 300001;
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /expired/);
});
test('source changes invalidate preview before model call', async () => {
  let count = 0;
  const service = createReviewService({ stream() { assert.fail('no model call'); } }, { capture: async () => ({ ...snapshot(), id: String(++count) }), allowModelSending: true, authorize: async () => true });
  const e = exec(), p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /Files changed/);
});
test('approval denial prevents model sending despite confirmed argument', async () => {
  const service = createReviewService({ stream() { assert.fail('must not send'); } }, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => false });
  const e = exec(), p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /approval denied/);
});

test('disposing cancels in-flight capture and rejects future calls', async () => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const service = createReviewService(llm, { capture: async (_cwd, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const pending = service.preview({}, exec());
  await ready; service.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(service.preview({}, exec()), /disposed/);
});

test('model sending is disabled by default', async () => {
  const service = createReviewService(llm, { capture: async () => snapshot() }); const e = exec();
  const p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /disabled/);
});
