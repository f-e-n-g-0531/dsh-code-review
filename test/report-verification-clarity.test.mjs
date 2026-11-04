import test from 'node:test';
import assert from 'node:assert/strict';
import { findingsMarkdown, findingDisposition } from '../src/report-findings.mjs';
import { reportSummaryData, reportSummaryMarkdown, verificationPresentation } from '../src/report-summary.mjs';
import { markdownReport } from '../src/review.mjs';

const candidate = (status = 'completed', verdict = 'supported') => ({
  fileId: 'f', path: 'src/<unsafe>.cpp', title: 'Rejected request destroys active state', severity: 'high',
  anchor: {kind: 'line', side: 'new', start: 4, end: 6},
  evidence: 'state assignment moved before validation', trigger: 'invalid request during active state',
  impact: 'active request loses its state', suggestion: 'move assignment after validation',
  attribution: {beforeBehavior: 'validate then assign', afterBehavior: 'assign then validate', extra: 'keep'},
  verification: {status, verdict, reason: 'external precondition not established',
    evidence: [{sourceId: 'old', status: 'references-validated'}, {sourceId: 'new', status: 'references-validated'}],
    regression: {status: 'comparison-references-validated', classification: 'introduced', oldEvidence: [0], newEvidence: [1]}}
});
const body = report => findingsMarkdown(report).join('\n');
const summary = report => reportSummaryMarkdown(report).join('\n');

test('completed uncertain and incomplete verification have distinct sections and summary counts', () => {
  const report = {findings: [candidate('completed', 'uncertain'), candidate('incomplete'), candidate('pending')]};
  const text = body(report), head = summary(report);
  assert.match(text, /### 复核后不确定/);
  assert.match(text, /### 复核未完成/);
  assert.match(head, /复核支持 0；已复核不确定 1；复核未完成（未复核或未完成有效复核） 2/);
  assert.equal(reportSummaryData(report).counts.unresolved, 3);
  assert.equal(reportSummaryData(report).unverifiedCandidates, 2);
});

test('completed uncertain with empty evidence is a finished uncertain verdict, not an unfinished run', () => {
  const finding = candidate('completed', 'uncertain'); finding.verification.evidence = [];
  const report = {status: 'completed', files: [{fileId: 'f', status: 'completed'}], findings: [finding]};
  assert.equal(verificationPresentation(finding), 'uncertain');
  assert.equal(reportSummaryData(report).complete, true);
  assert.match(summary(report), /已复核不确定 1；复核未完成（未复核或未完成有效复核） 0/);
  assert.doesNotMatch(body(report), /### 复核未完成/);
});

test('unfinished and uncertain cards qualify every primary hypothesis without deleting original fields', () => {
  for (const finding of [candidate('incomplete'), candidate('completed', 'uncertain')]) {
    const report = {findings: [finding]}, original = structuredClone(report), text = body(report);
    for (const label of ['主审假说：', '主审拟议严重程度', '已知差异／线索', '待证触发条件', '影响假说', '待验证方案', '不是必改项', '修改前（主审描述，待核实）', '修改后（主审描述，待核实）']) assert.ok(text.includes(label), label);
    for (const field of ['title', 'evidence', 'trigger', 'impact', 'suggestion']) assert.ok(text.includes(finding[field]), field);
    assert.doesNotMatch(text, /- 建议：|- 什么情况下发生：|- 可能造成的影响：|#### 1. Rejected/);
    assert.match(text, /&lt;unsafe&gt;/);
    assert.deepEqual(report, original);
  }
});

test('supported introduced, preexisting and project categories retain strict existing safeguards', () => {
  const finding = candidate();
  assert.equal(verificationPresentation(finding), 'introduced');
  finding.verification.regression.classification = 'preexisting';
  assert.equal(verificationPresentation(finding), 'preexisting');
  assert.match(body({findings: [finding]}), /### 原有问题（复核支持）/);
  for (const mode of [{mode: 'project'}, {reviewMode: 'project'}, {projectScope: {}}]) {
    assert.equal(verificationPresentation(finding, mode), 'current');
    assert.match(body({...mode, findings: [finding]}), /### 当前源码问题（复核支持）/);
    assert.equal(reportSummaryData({...mode, findings: [finding]}).counts.introduced, 0);
  }
  finding.verification.evidence = [];
  assert.equal(verificationPresentation(finding, {mode: 'project'}), 'uncertain');
});

test('completed supported without validated comparison stays uncertain, never promoted to introduced', () => {
  for (const mutate of [f => delete f.verification.regression, f => f.verification.regression.newEvidence = [0], f => f.verification.evidence[0].status = 'unvalidated']) {
    const finding = candidate(); mutate(finding);
    assert.equal(verificationPresentation(finding), 'uncertain');
    assert.match(body({findings: [finding]}), /### 复核后不确定/);
    assert.doesNotMatch(body({findings: [finding]}), /### 本次新增/);
    assert.equal(reportSummaryData({findings: [finding]}).counts.introduced, 0);
  }
});

test('refuted cards cannot be confused with supported repair requirements', () => {
  const finding = candidate('completed', 'refuted'), text = body({findings: [finding]});
  assert.equal(verificationPresentation(finding), 'refuted');
  assert.match(text, /### 已反驳/); assert.match(text, /反证结论/);
  assert.match(text, /主审假说：/); assert.doesNotMatch(text, /- 建议：/);
  finding.verification.status = 'incomplete';
  assert.equal(verificationPresentation(finding), 'incomplete');
});

test('legacy missing verification remains visible and legacy aggregate API stays compatible', () => {
  const finding = candidate(); delete finding.verification;
  assert.equal(findingDisposition(finding), '待核实');
  assert.equal(verificationPresentation(finding), 'incomplete');
  assert.match(body({findings: [finding]}), /### 复核未完成/);
  assert.match(body({findings: [finding]}), /原主审建议（待验证，不是必改项）/);
  assert.match(summary({}), /复核支持 0；已复核不确定 0；复核未完成（未复核或未完成有效复核） 0/);
});

test('full appendix remains available with raw evidence, trigger, impact, suggestion and reasoning', () => {
  const finding = candidate('completed', 'uncertain');
  finding.verification.evidence[0].text = 'COMPLETE RECEIPT';
  const report = {status: 'partial', snapshotId: 's', findings: [finding], files: []};
  const before = structuredClone(report), text = markdownReport(report), appendix = text.split('## 技术附录')[1];
  for (const value of ['COMPLETE RECEIPT', finding.trigger, finding.impact, finding.evidence, finding.suggestion, finding.verification.reason]) assert.ok(appendix.includes(value), value);
  assert.deepEqual(report, before);
  assert.equal(markdownReport(report), text);
});
