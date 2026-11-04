import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
import { reportSummaryData, reportSummaryMarkdown } from '../src/report-summary.mjs';
import { limitationDetailsMarkdown } from '../src/report-readability.mjs';
import { buildResumeState, validateResumeState } from '../src/review-resume.mjs';
import { createReviewJobs } from '../src/review-jobs.mjs';

const notice = '初始输入仅提供聚焦上下文或身份目录，其他批准全文须按需读取；不声明所有上下文已核查。';
const snapshot = () => ({ id: 'scope-notice', vcs: 'git', files: [{ id: 'f', path: 'main.js', eligibility: 'reviewable', left: { text: 'export const value = 1;\n' }, right: { text: 'export const value = 2;\n' }, properties: [] }], context: [{ path: 'unrelated.js', text: 'approved but deferred' }], rules: [] });
const options = { enableRetrieval: true, focusPrimaryContext: true };
const empty = async () => ({ findings: [], limitations: [] });
const identity = { captureOptions: {}, route: { provider: 'test', model: 'fixture' }, runtime: { version: 'fixture' }, execution: options };

test('context scope: navigation-only host notice permits completed processing, not context coverage', async () => {
  const report = await reviewSnapshot(snapshot(), async request => {
    const payload = JSON.parse(request.input);
    assert.equal(payload.contextMode, 'approved-retrieval');
    assert.deepEqual(payload.context, []);
    return { findings: [], limitations: [], scopeNotices: [{ fileId: 'forged', text: 'ignored model notice' }] };
  }, options);
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.limitations, []);
  assert.deepEqual(report.scopeNotices, [{ fileId: 'f', text: notice }]);
  const summary = reportSummaryData(report);
  assert.equal(summary.complete, true);
  assert.equal(summary.scopeNotices, 1);
  assert.equal(summary.limitations, 0);
  const markdown = markdownReport(report);
  assert.match(markdown, /范围说明：1 项/);
  assert.match(markdown, /完成不等于全部批准上下文已核查/);
  assert.ok(markdown.includes(notice));
  assert.match(markdown, /"fileId": "f"/);
  assert.match(markdown, /范围：main\\.js/);
  assert.doesNotMatch(markdown, /ignored model notice/);
});

test('context scope: identical model text and unknown limitations remain partial regardless of tags', async () => {
  for (const text of [notice, 'unknown model limitation']) {
    const report = await reviewSnapshot(snapshot(), async () => ({ findings: [], limitations: [text], scopeNotices: [], limitationTags: ['scope-notice'] }), options);
    assert.equal(report.status, 'partial');
    assert.deepEqual(report.limitations, [{ fileId: 'f', text }]);
    assert.deepEqual(report.scopeNotices, [{ fileId: 'f', text: notice }]);
  }
});

test('context scope: input and model call budget failures never become completed', async () => {
  for (const limits of [{ maxInputBytes: 1 }, { remainingCalls: () => 0 }]) {
    let calls = 0;
    const report = await reviewSnapshot(snapshot(), async () => { calls++; return empty(); }, { ...options, ...limits });
    assert.equal(calls, 0);
    assert.equal(report.status, 'partial');
    assert.notEqual(report.files[0].status, 'completed');
    assert.equal(reportSummaryData(report).complete, false);
  }
});

test('context scope: retrieval round exhaustion retains host limitation alongside notice', async () => {
  const report = await reviewSnapshot(snapshot(), async request => {
    const payload = JSON.parse(request.input);
    if (payload.retrievalFinalization) return { findings: [], limitations: [] };
    return { requests: [{ kind: 'read', id: payload.catalog[0].id, start: 1, count: 1 }] };
  }, { ...options, maxRetrievalRounds: 0 });
  assert.equal(report.status, 'partial');
  assert.equal(report.scopeNotices.length, 1);
  assert.ok(report.limitations.some(row => /检索预算受限/.test(row.text)));
  assert.equal(report.files[0].retrievalLimited, true);
});

test('context scope: other host limitations remain partial', async () => {
  const input = snapshot();
  input.autoContext = { truncated: true, candidates: [] };
  const report = await reviewSnapshot(input, empty, options);
  assert.equal(report.files[0].status, 'completed');
  assert.equal(report.status, 'partial');
  assert.match(report.limitations[0].text, /自动上下文未完全捕获/);
  assert.equal(report.scopeNotices.length, 1);
});

test('context scope: checkpoints retain contextMode and resume regenerates notices without model calls', async () => {
  let checkpoint;
  const input = snapshot();
  await reviewSnapshot(input, empty, { ...options, onResumeCheckpoint: report => { checkpoint = structuredClone(report); } });
  const stored = buildResumeState(input, identity, checkpoint);
  const resumed = validateResumeState(stored, input, identity);
  assert.equal(resumed.completed[0].state.contextMode, 'approved-retrieval');
  const report = await reviewSnapshot(input, async () => { assert.fail('reused chain must not invoke a model'); }, { ...options, resumeState: resumed });
  assert.equal(report.status, 'completed');
  assert.equal(report.modelCalls, 0);
  assert.deepEqual(report.scopeNotices, [{ fileId: 'f', text: notice }]);
});

test('context scope: historical limitation text is not migrated or upgraded on resume/render', async () => {
  const input = snapshot();
  const historical = await reviewSnapshot(input, empty, options);
  historical.status = 'partial';
  historical.limitations = [{ fileId: 'f', text: notice }];
  delete historical.scopeNotices;
  const before = structuredClone(historical);
  assert.match(reportSummaryMarkdown(historical).join('\n'), /尚未查完/);
  assert.ok(limitationDetailsMarkdown(historical).join('\n').includes(notice));
  assert.deepEqual(historical, before);
  const resumeState = validateResumeState(buildResumeState(input, identity, historical), input, identity);
  const report = await reviewSnapshot(input, empty, { ...options, resumeState });
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.limitations, historical.limitations);
  assert.equal(report.scopeNotices.length, 1);
});

test('context scope: appendix retains complete notice values, duplicate order and all ownership', () => {
  const scopeNotices = [{ fileId: 'f', text: '<tag> ' + 'long'.repeat(150), metadata: { sequence: 1 } }, { fileId: 'other', text: notice }, { fileId: 'f', text: notice }];
  const report = { files: [{ fileId: 'f', path: 'main.js' }], scopeNotices };
  const before = structuredClone(report);
  const markdown = limitationDetailsMarkdown(report).join('\n');
  const json = markdown.match(/<pre>(\[[\s\S]*?\])<\/pre>/)[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.deepEqual(JSON.parse(json), scopeNotices);
  assert.match(markdown, /未知文件身份：other/);
  assert.deepEqual(report, before);
});

test('context scope: paged background job exposes totalScopeNotices independently of limitations', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'context-scope-job-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = createReviewJobs({ directory });
  t.after(() => jobs.dispose());
  const exec = { agent: { session: { header: { id: 'scope-owner', cwd: process.cwd() } }, options: { provider: 'test', model: 'fixture' } } };
  const started = await jobs.start(exec, async () => ({ report: await reviewSnapshot(snapshot(), empty, options) }));
  await jobs.wait(started.jobId, exec, { waitFor: 'terminal', timeoutMs: 5000 });
  const page = await jobs.status(started.jobId, exec, { offset: 0, limit: 1 });
  assert.equal(page.resultSummary.totalScopeNotices, 1);
  assert.equal(page.resultSummary.totalLimitations, 0);
  assert.equal(page.resultSummary.status, 'completed');
});
