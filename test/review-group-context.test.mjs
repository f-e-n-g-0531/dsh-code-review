import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
test('relation Markdown escapes source paths and relation reasons', () => {
  const text = markdownReport({ status: 'completed', snapshotId: 's', files: [{ fileId: 'a', path: '<img>.ts', status: 'completed' }, { fileId: 'b', path: '[click](bad).ts', status: 'completed' }], findings: [], limitations: [], grouping: { links: [{ from: 'a', to: 'b', reasons: ['<script>'], split: true }] } });
  assert.ok(!text.includes('<img>')); assert.ok(!text.includes('<script>'));
  assert.match(text, /&lt;script&gt;/); assert.match(text, /已拆组/);
});

test('cross-file regression fixture passes related evidence and validates only primary anchor', async () => {
  const s = snapshot();
  s.files[0].left.text = 'export const timeout = 1000;';
  s.files[0].right.text = 'export const timeout = 1;';
  s.files[1].left.text = 'assert.equal(timeout, 1000);';
  s.files[1].right.text = 'assert.ok(timeout >= 1000);';
  const report = await reviewSnapshot(s, async r => {
    const p = JSON.parse(r.input);
    if (p.sourceMode === 'file-interaction') return { findings: [], limitations: [] };
    if (p.file.id.startsWith('test/')) return { findings: [], limitations: [] };
    assert.match(p.relatedFiles[0].right.text, /timeout >= 1000/);
    return { findings: [{ fileId: p.file.id, severity: 'high', title: '超时单位回归', evidence: '测试要求至少1000，实现改为1', trigger: '请求需要超过1毫秒', impact: '请求提前超时', suggestion: '恢复毫秒值', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: p.file.right.text }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: '1000毫秒', afterBehavior: '1毫秒', reason: '本次降低超时阈值' } }], limitations: [] };
  }, { enableGrouping: true, enableRetrieval: true });
  assert.equal(report.status, 'completed'); assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].fileId, s.files[0].id);
  assert.match(markdownReport(report), /关联上下文/);
  assert.match(markdownReport(report), /每个主文件独立审查/);
});

const snapshot = () => ({ id: 's', vcs: 'git', files: ['src/a.ts', 'test/a.test.ts'].map(id => ({ id, path: id, eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] })), context: [] });
test('importing caller receives changed dependency guard as context without double coverage', async () => {
  const s = snapshot();
  s.files[0].path = 'src/caller.ts'; s.files[0].id = 'caller';
  s.files[0].left.text = s.files[0].right.text = "import { guardedRun } from './guard';";
  s.files[1].path = 'src/guard.ts'; s.files[1].id = 'guard';
  s.files[1].left.text = 'export const guardedRun = () => validate();';
  s.files[1].right.text = 'export const guardedRun = () => validateAndRun();';
  const seen = [];
  const report = await reviewSnapshot(s, async request => {
    const p = JSON.parse(request.input); seen.push(p.file.id);
    assert.equal(p.relatedFiles.length, 1);
    assert.ok(p.relations[0].reasons.some(r => r.startsWith('relative-import:')));
    if (p.file.id === 'caller') assert.match(p.relatedFiles[0].right.text, /validateAndRun/);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true, enableRetrieval: true });
  assert.equal(report.status, 'completed');
  assert.equal(seen.length, 2);
  assert.equal(report.coverage.completed, 2);
  assert.equal(report.findings.length, 0);
});
test('group context retains one primary review per file with approved related sides', async () => {
  const seen = [];
  const report = await reviewSnapshot(snapshot(), async request => {
    const p = JSON.parse(request.input); seen.push(p.file.id);
    assert.equal(p.relatedFiles.length, 1);
    assert.notEqual(p.relatedFiles[0].id, p.file.id);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true });
  assert.equal(report.status, 'completed'); assert.equal(new Set(seen).size, 2);
  assert.equal(report.grouping.groups.length, 1);
});
test('retrieval overhead participates in grouping fallback before any model call', async () => {
  let groupedBytes = 0;
  await reviewSnapshot(snapshot(), async r => { groupedBytes = Math.max(groupedBytes, Buffer.byteLength(r.input) + Buffer.byteLength(r.instructions)); return { findings: [], limitations: [] }; }, { enableGrouping: true });
  const result = await reviewSnapshot(snapshot(), async r => {
    assert.ok(Buffer.byteLength(r.input) + Buffer.byteLength(r.instructions) <= groupedBytes);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true, enableRetrieval: true, maxInputBytes: groupedBytes });
  assert.ok(result.files.every(f => f.groupFallback === 'input-budget'));
  assert.ok(result.files.every(f => f.status !== 'failed'));
});

test('over-budget related text falls back without hiding missing group coverage', async () => {
  const s = snapshot(); s.files[1].right.text = 'x'.repeat(6000);
  const report = await reviewSnapshot(s, async request => {
    assert.equal(JSON.parse(request.input).relatedFiles, undefined);
    return { findings: [], limitations: [] };
  }, { enableGrouping: true, maxInputBytes: 5000 });
  assert.equal(report.status, 'partial');
  assert.equal(report.files[0].groupFallback, 'input-budget');
  assert.equal(report.files[0].status, 'completed');
  assert.equal(report.files[1].status, 'blocked');
});
