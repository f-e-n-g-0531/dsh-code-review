import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
const snapshot = { id: 'snap', vcs: 'git', files: [{ id: 'f1', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }] };
const generated = { findings: [{ fileId: 'f1', severity: 'high', title: 'bug', evidence: 'e', trigger: 't', impact: 'i', suggestion: 's', anchor: { kind: 'file' } }], limitations: [] };
const options = { enableRetrieval: true, enableVerification: true };
test('rule report escapes untrusted paths without duplicating rule bodies', async () => {
  const input = structuredClone(snapshot);
  input.rules = [{ path: '<img src=x onerror=alert(1)>.md', hash: 'a'.repeat(64), text: 'PRIVATE_RULE_BODY' }];
  const report = await reviewSnapshot(input, async () => ({ findings: [], limitations: [] }), options);
  assert.deepEqual(report.rules, [{ path: input.rules[0].path, hash: input.rules[0].hash }]);
  const markdown = markdownReport(report);
  assert.ok(!markdown.includes('<img'));
  assert.ok(!markdown.includes('PRIVATE_RULE_BODY'));
  assert.ok(!JSON.stringify(report).includes('PRIVATE_RULE_BODY'));
  assert.ok(markdown.includes('a'.repeat(64)));
});
test('both phases use the same immutable rules data within input budget', async () => {
  const input = structuredClone(snapshot);
  input.rules = [{ path: 'rules.md', text: 'Do not leak resources', hash: 'fixture' }];
  let calls = 0;
  await reviewSnapshot(input, async request => {
    const payload = JSON.parse(request.input);
    assert.equal(payload.rules[0].text, 'Do not leak resources');
    assert.match(request.instructions, /不可信/);
    if (++calls === 1) { input.rules[0].text = 'mutated'; return generated; }
    return { verdicts: [{ candidateId: 'c1', verdict: 'uncertain', reason: 'Need evidence', evidence: [] }] };
  }, options);
  assert.equal(calls, 2);
  input.rules[0].text = 'x'.repeat(100000);
  const report = await reviewSnapshot(input, () => assert.fail('over-budget rules sent'), options);
  assert.equal(report.coverage.blocked, 1);
});
test('verification consumes global budget before later primary files', async () => {
  const input = structuredClone(snapshot);
  input.files.push({ ...structuredClone(input.files[0]), id: 'f2', path: 'b.js' });
  let calls = 0;
  const report = await reviewSnapshot(input, async request => {
    const payload = JSON.parse(request.input);
    if (++calls === 1) { assert.equal(payload.file.id, 'f1'); return generated; }
    assert.equal(payload.candidates[0].finding.fileId, 'f1');
    return { verdicts: [{ candidateId: 'c1', verdict: 'uncertain', reason: 'Needs context', evidence: [] }] };
  }, { ...options, maxCalls: 2 });
  assert.equal(calls, 2);
  assert.equal(report.modelCalls, 2);
  assert.equal(report.files[0].status, 'completed');
  assert.equal(report.files[1].status, 'pending');
  assert.match(report.files[1].reason, /预算耗尽/);
  assert.equal(report.coverage.pending, 1);
  assert.equal(report.status, 'partial');
});
test('cancellation during verification waits for cleanup and never starts next file', async () => {
  const controller = new AbortController();
  const input = structuredClone(snapshot);
  input.files.push({ ...structuredClone(input.files[0]), id: 'f2', path: 'b.js' });
  let calls = 0, cleaned = false;
  const report = await reviewSnapshot(input, async ({ signal }) => {
    if (++calls === 1) return generated;
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    controller.abort(new Error('user cancelled verification'));
    await aborted;
    await new Promise(resolve => setImmediate(resolve));
    cleaned = true;
    throw signal.reason;
  }, { ...options, signal: controller.signal });
  assert.equal(cleaned, true);
  assert.equal(calls, 2);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.coverage.cancelled, 2);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.status, 'incomplete');
});
test('full review validates retrieved counterevidence and retains refuted candidate', async () => {
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async request => {
    calls++;
    if (calls === 1) return generated;
    const input = JSON.parse(request.input);
    if (calls === 2) return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] };
    const { endOfSource, ...ref } = input.retrieved[0].result;
    assert.equal(ref.text, 'old');
    return { verdicts: [{ candidateId: input.candidates[0].candidateId, verdict: 'refuted', reason: 'Old side already exhibits this behavior', evidence: [ref] }] };
  }, options);
  assert.equal(report.modelCalls, 3);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.verdict, 'refuted');
  assert.equal(report.findings[0].verification.evidence[0].sourceId, 's1');
  assert.equal(report.retrievalUsage.calls, 2); // retrieval plus exact evidence validation
  assert.equal(report.files[0].retrievalAudit.length, 1);
  assert.match(markdownReport(report), /模型复核反驳/);
});
test('forged verification evidence preserves candidates without accepting a verdict', async () => {
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async () => ++calls === 1 ? generated : { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'claimed proof', evidence: [{ snapshotId: 'snap', sourceId: 's2', hash: '0'.repeat(64), start: 1, count: 1, text: 'new' }] }] }, options);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.status, 'incomplete');
  assert.equal(report.findings[0].verification.verdict, undefined);
  assert.equal(report.status, 'partial');
  assert.ok(report.limitations.some(l => l.text.includes('does not match')));
});
test('verification cannot retrieve excluded source content', async () => {
  const input = structuredClone(snapshot);
  input.files.push({ id: 'secret', path: 'secret', eligibility: 'excluded', left: { text: 'SECRET' }, right: { text: 'SECRET' } });
  let calls = 0;
  const report = await reviewSnapshot(input, async request => {
    assert.ok(!request.input.includes('SECRET'));
    return ++calls === 1 ? generated : { requests: [{ kind: 'read', id: 's3', start: 1, count: 1 }] };
  }, options);
  assert.equal(calls, 2);
  assert.equal(report.findings[0].verification.status, 'incomplete');
  assert.equal(report.retrievalUsage.calls, 0);
});
test('refuted candidates remain visible and untrusted evidence is escaped', async () => {
  const report = await reviewSnapshot(snapshot, async () => generated);
  report.findings[0].verification = { status: 'completed', verdict: 'refuted', reason: '<script>bad</script>', evidence: [{ sourceId: '<s>', start: 1, count: 1, hash: 'abc', text: '[click](javascript:bad)' }] };
  const markdown = markdownReport(report);
  assert.match(markdown, /模型复核反驳（保留候选供追溯）/);
  assert.match(markdown, /不是事实或因果证明/);
  assert.ok(!markdown.includes('<script>'));
  assert.ok(!markdown.includes('[click](javascript:bad)'));
  assert.equal(report.findings.length, 1);
});
test('optional verification shares model budget and retains candidates on exhaustion', async () => {
  const report = await reviewSnapshot(snapshot, async () => generated, { ...options, maxCalls: 1 });
  assert.equal(report.modelCalls, 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.status, 'incomplete');
  assert.equal(report.status, 'partial');
  assert.match(markdownReport(report), /复核状态：未完成/);
});
test('generation and verification receive same timeout signal', async () => {
  let first; let calls = 0; let cleaned = false;
  const report = await reviewSnapshot(snapshot, async ({ signal }) => {
    if (++calls === 1) { first = signal; return { ...generated, limitations: ['Missing caller context'] }; }
    assert.equal(signal, first);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    cleaned = true; throw signal.reason;
  }, { ...options, timeoutMs: 30 });
  assert.equal(cleaned, true); assert.equal(report.status, 'failed');
  assert.ok(report.limitations.some(l => l.text === 'Missing caller context'));
  assert.ok(report.limitations.some(l => l.text.includes('缺少变更归因')));
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verification.status, 'incomplete');
});
test('uncertain verdict is retained without rewriting candidate anchor', async () => {
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async () => ++calls === 1 ? generated : { verdicts: [{ candidateId: 'c1', verdict: 'uncertain', reason: 'Need more context', evidence: [] }] }, options);
  assert.equal(report.modelCalls, 2);
  assert.equal(report.findings[0].verification.verdict, 'uncertain');
  assert.ok(report.limitations.some(l => l.text.includes('仍不确定')));
  assert.deepEqual(report.findings[0].anchor, { kind: 'file' });
  assert.match(markdownReport(report), /复核状态：不确定/);
});
