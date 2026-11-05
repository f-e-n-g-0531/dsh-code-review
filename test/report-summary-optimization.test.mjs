import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSummaryData, reportSummaryMarkdown, supportedFindingPriorities } from '../src/report-summary.mjs';
import { markdownReport } from '../src/review.mjs';

const candidate = (severity = 'high', classification = 'introduced') => ({
  fileId: 'f', path: 'src/file.cpp', title: 'original candidate', severity,
  anchor: {kind: 'line', side: 'new', start: 1, end: 1},
  verification: {status: 'completed', verdict: 'supported',
    evidence: [{sourceId: 'old', status: 'references-validated'}, {sourceId: 'new', status: 'references-validated'}],
    regression: {status: 'comparison-references-validated', classification, oldEvidence: [0], newEvidence: [1]}},
});
const report = findings => ({status: 'completed', snapshotId: 's', files: [{fileId: 'f', path: 'src/file.cpp', status: 'completed'}], findings});
const text = value => reportSummaryMarkdown(value).join('\n');

test('first-screen counts separate supported categories and unresolved actions', () => {
  const current = candidate(); current.attribution = {causality: 'current-source-only'};
  const uncertain = candidate(); uncertain.verification.verdict = 'uncertain';
  const incomplete = candidate(); incomplete.verification.status = 'pending';
  const value = report([candidate(), candidate('low', 'preexisting'), current, uncertain, incomplete]);
  const lines = reportSummaryMarkdown(value), data = reportSummaryData(value);
  assert.match(lines[2], /^- 复核支持本次新增 1；当前源码复核支持 1；复核支持原有 1；尚未查完/);
  assert.match(lines[3], /已复核不确定 1、复核未完成 1.*先核实而非直接修复.*已加载未完成条目 1.*不能视为无问题/);
  assert.deepEqual(data.verification, {supported: 3, uncertain: 1, incomplete: 1});
  assert.equal(data.counts.unresolved, 2);
});

test('priorities retain original candidate numbers, stable severity ties and category boundaries', () => {
  const findings = [candidate('low'), candidate('critical', 'preexisting'), candidate('high'), candidate('high'), candidate('critical'), candidate('constructor')];
  const value = report(findings), before = structuredClone(value);
  assert.deepEqual(supportedFindingPriorities(value).map(item => item.candidate), [5, 3, 4, 1, 6, 2]);
  assert.equal(supportedFindingPriorities(value)[4].severity, 'unknown');
  assert.match(text(value), /候选 5（本次新增／严重）.*候选 3（本次新增／高）.*其余 1 项/);
  assert.deepEqual(value, before);
  const data = reportSummaryData(value); data.priorities[0].candidate = 999;
  assert.equal(supportedFindingPriorities(value)[0].candidate, 5);
});

test('severity or arbitrary title never upgrades missing or inconsistent evidence', () => {
  const mutations = [f => delete f.verification, f => f.verification.status = 'verified',
    f => f.verification.evidence = [], f => f.verification.evidence[0].status = 'unchecked',
    f => f.verification.regression.newEvidence = [0], f => delete f.verification.regression.status,
    f => f.verification.verdict = 'uncertain', f => f.verification.verdict = 'refuted'];
  for (const mutate of mutations) {
    const f = candidate('critical'); mutate(f); f.title = 'Confirmed critical introduced defect';
    const value = report([f]);
    assert.deepEqual(supportedFindingPriorities(value), []);
    assert.equal(reportSummaryData(value).counts.introduced, 0);
    assert.match(reportSummaryMarkdown(value)[2], /尚无复核支持的问题/);
    assert.doesNotMatch(text(value), /优先核对/);
  }
});

test('unsafe model fields and unknown statuses cannot enter first-screen text', () => {
  const f = candidate('<script>'), unsafe = '[open](javascript:evil)\n<script>SECRET';
  Object.assign(f, {title: unsafe, evidence: unsafe, impact: unsafe, suggestion: unsafe});
  const value = report([f]); value.status = unsafe; value.files[0].path = unsafe; value.files[0].status = unsafe;
  const before = structuredClone(value), rendered = text(value);
  assert.match(rendered, /状态未知/); assert.match(rendered, /未分级/);
  assert.doesNotMatch(rendered, /javascript:|<script>|SECRET/);
  assert.equal(reportSummaryData(value).complete, false);
  assert.deepEqual(value, before);
});

test('partial cancelled interrupted and legacy states expose missing progress despite zero support', () => {
  for (const status of ['partial', 'cancelled', 'interrupted', 'failed', 'running', 'pending', 'legacy', undefined]) {
    const value = report([]); value.status = status;
    const lines = reportSummaryMarkdown(value);
    assert.match(lines[2], /尚未查完.*不得据此放行/);
    assert.match(lines[3], /无复核支持的问题不等于审核通过.*不能视为无问题/);
    assert.equal(reportSummaryData(value).complete, false);
  }
});

test('missing loaded details and cross-file stages never become clean conclusions', () => {
  const value = report([]); value.coverage = {total: 3, completed: 2, pending: 1};
  value.interactions = [{status: 'pending'}]; value.stageContinuation = {pending: 1};
  assert.match(reportSummaryMarkdown(value)[3], /已加载未完成条目 0，明细尚未加载齐.*须补齐未完成范围和阶段/);
  assert.match(text(value), /跨文件综合：完成 0\/1/);
  assert.equal(reportSummaryData(value).complete, false);
});

test('outdated and no-findings completed reports retain no-clean and provenance caveats', () => {
  const value = report([]);
  assert.equal(reportSummaryData(value).complete, true);
  assert.match(text(value), /未记录候选问题；不得据此放行/);
  assert.match(text(value), /空发现不证明无缺陷/);
  value.outdated = true;
  assert.match(reportSummaryMarkdown(value)[2], /报告已过期/);
  assert.match(reportSummaryMarkdown(value)[3], /先基于当前批准快照重新审核/);
  assert.match(text(value), /不能作为当前源码结论/);
});

test('project support never becomes introduced and completed uncertainty is not unfinished verification', () => {
  const value = report([candidate()]); value.mode = 'project';
  assert.match(reportSummaryMarkdown(value)[2], /^- 当前源码复核支持 1；/);
  assert.equal(reportSummaryData(value).counts.introduced, 0);
  value.findings[0].verification.verdict = 'uncertain'; value.findings[0].verification.evidence = [];
  assert.equal(reportSummaryData(value).complete, true);
  assert.deepEqual(reportSummaryData(value).verification, {supported: 0, uncertain: 1, incomplete: 0});
  assert.match(reportSummaryMarkdown(value)[3], /处理已结束，不代表所有疑点已排除/);
});

test('markdown integration uses optimized summary before findings without reordering raw appendix', () => {
  const value = report([candidate('low'), candidate('critical')]), before = structuredClone(value);
  const rendered = markdownReport(value);
  assert.ok(rendered.indexOf('## 结论摘要') < rendered.indexOf('## 审查发现'));
  const summary = rendered.slice(rendered.indexOf('## 结论摘要'), rendered.indexOf('## 审查发现'));
  assert.match(summary, /候选 2（本次新增／严重）；候选 1（本次新增／低）/);
  assert.ok(rendered.includes('## 技术附录'));
  assert.deepEqual(value, before);
});
