import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
const snapshot = (before, after) => ({ id: 'snapshot', vcs: 'git', files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', left: { text: before }, right: { text: after }, properties: [] }] });
test('review passes deterministic diff and full sources without trusting supplied changes', async () => {
  const input = snapshot('a\nb\n', 'a\nx\n');
  input.files[0].changes = { status: 'unchanged' };
  const report = await reviewSnapshot(input, async request => {
    const payload = JSON.parse(request.input);
    assert.equal(payload.changes.status, 'changed');
    assert.equal(payload.changes.edits[0].new.start, 2);
    assert.equal(payload.changes.edits[0].added, undefined);
    assert.equal(payload.changes.hunks[0].new.text, undefined);
    assert.deepEqual(payload.changes.hunks[0].editIds, ['e1']);
    assert.equal(payload.file.left.text, 'a\nb\n');
    assert.equal(payload.file.right.text, 'a\nx\n');
    return { findings: [], limitations: [] };
  });
  assert.equal(report.status, 'completed');
});
const attributedFinding = () => ({ fileId: 'f', severity: 'high', title: '问题', evidence: '证据', trigger: '条件', impact: '影响', suggestion: '建议', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'new' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: '<script>old</script>', afterBehavior: '[new](javascript:alert(1))', reason: 'change <img src=x>' } });

test('attribution survives review with explicit unverified causality and escaped Markdown', async () => {
  const report = await reviewSnapshot(snapshot('old\n', 'new\n'), async request => {
    assert.match(request.instructions, /attribution/);
    return { findings: [attributedFinding()], limitations: [] };
  });
  assert.equal(report.status, 'completed');
  assert.equal(report.findings[0].attribution.causality, 'unverified');
  const markdown = markdownReport(report);
  assert.match(markdown, /因果解释未经独立验证/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.ok(!markdown.includes('<img'));
  assert.ok(!markdown.includes('[new]('));
});

test('forged attribution rejects a located finding rather than silently dropping its claim', async () => {
  const finding = attributedFinding(); finding.attribution.editIds = ['e999'];
  const report = await reviewSnapshot(snapshot('old\n', 'new\n'), async () => ({ findings: [finding], limitations: [] }));
  assert.equal(report.status, 'failed');
  assert.equal(report.findings.length, 0);
  assert.match(report.files[0].reason, /Unknown change reference/);
});

test('diff limits remain visible when full text review succeeds', async () => {
  const report = await reviewSnapshot(snapshot('a\n'.repeat(500), 'b\n'.repeat(500)), async request => {
    assert.equal(JSON.parse(request.input).changes.status, 'limited');
    return { findings: [], limitations: [] };
  });
  assert.equal(report.modelCalls, 1);
  assert.equal(report.status, 'partial');
  assert.match(report.limitations[0].text, /精确变更分析受限/);
});
