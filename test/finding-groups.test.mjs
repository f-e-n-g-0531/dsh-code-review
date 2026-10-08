import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownReport } from '../src/review.mjs';
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
test('partial evidence overlap never produces transitive root-cause merge', () => {
  const a = finding('a'), b = finding('b');
  b.verification.evidence.push({ ...b.verification.evidence[0], sourceId: 's2' });
  assert.deepEqual(groupDuplicateFindings([a, b]), []);
});
