import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownReport, reviewSnapshot } from '../src/review.mjs';
import { groupDuplicateFindings } from '../src/finding-groups.mjs';
const finding = path => ({ path, title: 'same defect', severity: 'medium', trigger: 'same trigger', impact: 'same impact', attribution: { status: 'references-validated', beforeBehavior: 'before', afterBehavior: 'after', reason: 'same cause' }, verification: { status: 'completed', verdict: 'supported', reason: 'same verification', evidence: [{ snapshotId: 'snap', sourceId: 's1', hash: 'hash', start: 1, count: 1, text: 'code', status: 'references-validated' }] } });
test('exact shared supported evidence groups across paths without dropping originals', () => {
  const findings = [finding('a.js'), finding('b.js')];
  const original = structuredClone(findings);
  const groups = groupDuplicateFindings(findings);
  assert.deepEqual(groups[0].findingIndices, [0, 1]);
  assert.equal(groups[0].causality, 'unverified');
  assert.deepEqual(findings, original);
});
test('same title differing trigger evidence severity or verdict never merges', () => {
  for (const mutate of [f => f.trigger = 'other', f => f.severity = 'high', f => f.verification.verdict = 'refuted', f => f.verification.status = 'incomplete', f => f.verification.evidence[0].hash = 'other', f => f.attribution.reason = 'other cause']) {
    const other = finding('b'); mutate(other);
    assert.deepEqual(groupDuplicateFindings([finding('a'), other]), []);
  }
});
test('Markdown condenses only exact repeated explanation but keeps both original locations', () => {
  const findings = [finding('a.js'), finding('<b>.js')];
  findings.forEach((f, i) => { f.anchor = { kind: 'line', side: 'new', start: i + 1, end: i + 1, snippet: 'source' }; f.attribution.editIds = ['e1']; f.attribution.properties = []; });
  const report = { status: 'completed', snapshotId: 'snap', files: [], findings, limitations: [], findingGroups: [] };
  const text = markdownReport(report);
  assert.match(text, /重复报告候选/);
  assert.match(text, /&lt;b&gt;/);
  assert.match(text, /new:2-2/);
  assert.equal(findings.length, 2);
  findings[1].verification.verdict = 'refuted';
  assert.ok(!markdownReport(report).includes('重复报告候选'));
});
test('legacy full review retains shared receipts without inferring assessed regression duplicates', async () => {
  const snapshot = { id: 'snap', vcs: 'git', context: [], files: ['a.js', 'b.js'].map(id => ({ id, path: id, eligibility: 'reviewable', properties: [], left: { text: 'before' }, right: { text: 'after' } })) };
  const report = await reviewSnapshot(snapshot, async r => {
    const p = JSON.parse(r.input);
    if (p.file) return { findings: [{ fileId: p.file.id, severity: 'medium', title: 'shared cause', evidence: 'shared evidence', trigger: 'same', impact: 'same', suggestion: 'same', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'after' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'before', afterBehavior: 'after', reason: 'cause' } }], limitations: [] };
    if (!p.retrieved.length) return { requests: [{ kind: 'read', id: 's2', start: 1, count: 1 }] };
    return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'shared support', evidence: [{ receiptId: p.retrieved[0].result.receiptId }] }] };
  }, { enableRetrieval: true, enableVerification: true });
  assert.equal(report.modelCalls, 6);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findingGroups, []);
  assert.equal(report.regressionCoverage.unassessed, 2);
  assert.equal(report.findings[1].verification.evidence[0].text, 'after');
  assert.match(markdownReport(report), /尚未评估修改前后/);
  assert.ok(!markdownReport(report).includes('重复报告候选'));
});
test('conflicting before-after classifications and reasons never collapse', () => {
  const a = finding('a'), b = finding('b');
  a.verification.regression = { classification: 'introduced', reason: 'guard removed', oldEvidence: [0], newEvidence: [0] };
  for (const regression of [{ ...a.verification.regression, classification: 'preexisting' }, { ...a.verification.regression, classification: 'uncertain' }, { ...a.verification.regression, reason: 'other path' }]) {
    b.verification.regression = regression; assert.deepEqual(groupDuplicateFindings([a, b]), []);
  }
});
test('partial evidence overlap never produces transitive root-cause merge', () => {
  const a = finding('a'), b = finding('b');
  b.verification.evidence.push({ ...b.verification.evidence[0], sourceId: 's2' });
  assert.deepEqual(groupDuplicateFindings([a, b]), []);
});
