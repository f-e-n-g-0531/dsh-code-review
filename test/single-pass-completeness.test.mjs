import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSinglePassCompletion } from '../src/single-pass-completeness.mjs';
import { reviewSinglePass } from '../src/single-pass-review.mjs';
import { validateResponse } from '../src/review.mjs';

const snapshot = (count = 2) => ({ id: 's', vcs: 'git', context: [], rules: [], files: Array.from({ length: count }, (_, i) => ({ id: 'f' + i, path: 'file' + i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n', exists: true }, right: { text: 'unsafe();\n', exists: true } })) });
const completion = () => ({ status: 'completed', gaps: [] });
const empty = request => ({ reviews: JSON.parse(request.input).reviews.map(({ fileId }) => ({ fileId, findings: [], limitations: [], completion: completion(), assuranceNotes: [] })), limitations: [], completion: completion(), assuranceNotes: [] });
const candidate = fileId => ({ fileId, severity: 'high', title: 'Guard removed', evidence: 'unsafe operation', trigger: 'invalid state', impact: 'failure', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
const run = (mutate, source = snapshot(), extra = {}) => reviewSinglePass(source, request => { const value = empty(request); mutate(value, request); return value; }, { validateFindingResponse: validateResponse, ...extra });
const conserved = report => { assert.equal(Object.entries(report.coverage).filter(([key]) => key !== 'total').reduce((sum, [, count]) => sum + count, 0), report.files.length); assert.equal(report.modelCalls, 1); };

test('35 explicit complete members plus assurance notes complete static scope in one call', async () => {
  let calls = 0;
  const report = await run((value, request) => { calls++; assert.equal(request.strictSingleCall, true); assert.equal(request.maxOutputTokens, undefined); value.assuranceNotes = ['未构建或运行测试', '外部ABI未运行']; value.reviews[0].assuranceNotes = ['没有独立验证']; assert.ok(JSON.stringify(value).length < 5000); }, snapshot(35));
  assert.equal(calls, 1); assert.equal(report.status, 'completed'); assert.equal(report.coverage.completed, 35); assert.equal(report.orchestration.primaryComplete, true); assert.equal(report.assuranceNotes.length, 3); assert.equal(report.limitations.length, 1); conserved(report);
});

for (const scope of ['global', 'member']) test(scope + ' explicit missing dependency remains partial and keeps valid candidates', async () => {
  const report = await run(value => { value.reviews[0].findings = [candidate('f0')]; const target = scope === 'global' ? value : value.reviews[0]; target.completion = { status: 'incomplete', gaps: ['缺少关键依赖，无法核对调用前提'] }; });
  assert.equal(report.status, 'partial'); assert.equal(report.findings.length, 1); assert.equal(report.orchestration.primaryComplete, false); assert.equal(report.orchestration.modelCompletionComplete, false); assert.ok(report.limitations.some(item => item.code === 'SINGLE_PASS_SCOPE_GAP' && item.fileId === (scope === 'global' ? undefined : 'f0'))); if (scope === 'member') { assert.equal(report.files[0].status, 'pending'); assert.equal(report.files[0].primaryStatus, 'partial'); } conserved(report);
});

for (const legacy of ['empty', 'assurance-like', 'true-gap']) test('legacy ' + legacy + ' never silently declares completion', async () => {
  const report = await run(value => { delete value.completion; for (const row of value.reviews) delete row.completion; if (legacy !== 'empty') value.limitations = [legacy === 'assurance-like' ? '未构建，未运行外部ABI' : 'Dependency missing']; });
  assert.equal(report.status, 'partial'); assert.equal(report.completeness.status, 'needs-classification'); assert.equal(report.coverage.pending, 2); assert.equal(report.orchestration.primaryComplete, false); if (legacy !== 'empty') assert.ok(report.limitations.some(item => item.code === 'SINGLE_PASS_LEGACY_NEEDS_CLASSIFICATION')); conserved(report);
});

test('completed declarations cannot erase legacy limitations', async () => {
  const report = await run(value => { value.reviews[0].limitations = ['未构建']; });
  assert.equal(report.status, 'partial'); assert.equal(report.coverage.pending, 1); assert.equal(report.orchestration.modelCompletionComplete, false); conserved(report);
});

const corruptions = {
  'completed gaps contradiction': v => { v.completion.gaps = ['missing']; },
  'incomplete without evidence gap': v => { v.completion.status = 'incomplete'; },
  'missing completion key': v => { delete v.completion.gaps; },
  'unknown completion key': v => { v.completion.proof = true; },
  'unknown root': v => { v.protocolValid = true; },
  'unknown member': v => { v.reviews[1].fileId = 'unknown'; },
  'duplicate member': v => { v.reviews[1].fileId = 'f0'; },
  'missing member': v => { v.reviews.pop(); },
  'bad notes type': v => { v.assuranceNotes = 'test not run'; },
  'empty note': v => { v.reviews[1].assuranceNotes = [' ']; },
  'too many gaps': v => { v.completion = { status: 'incomplete', gaps: Array(51).fill('missing') }; },
  'long gap': v => { v.completion = { status: 'incomplete', gaps: ['x'.repeat(8001)] }; },
  'too many notes': v => { v.assuranceNotes = Array(51).fill('note'); },
  'long note': v => { v.assuranceNotes = ['x'.repeat(8001)]; },
};
for (const [name, mutate] of Object.entries(corruptions)) test(name + ' fails atomically before publication', async () => {
  const report = await run(value => { value.reviews[0].findings = [candidate('f0')]; mutate(value); });
  assert.equal(report.status, 'failed'); assert.equal(report.findings.length, 0); assert.equal(report.coverage.failed, 2); assert.equal(report.orchestration.primaryComplete, false); assert.equal(report.orchestration.protocolValid, false); conserved(report);
});

test('host capture gap cannot be erased by complete model declarations or assurance notes', async () => {
  const source = snapshot(); source.autoContext = { truncated: true };
  const report = await run(value => { value.assuranceNotes = ['全部完成']; }, source);
  assert.equal(report.status, 'partial'); assert.equal(report.orchestration.captureComplete, false); assert.equal(report.orchestration.primaryComplete, false); conserved(report);
});

test('bad anchor still fails its member and retains only other legal candidates', async () => {
  const report = await run(value => { value.reviews[0].findings = [candidate('f0')]; value.reviews[1].findings = [{ ...candidate('f1'), anchor: { ...candidate('f1').anchor, snippet: 'wrong' } }]; });
  assert.equal(report.status, 'partial'); assert.equal(report.coverage.failed, 1); assert.deepEqual(report.findings.map(item => item.fileId), ['f0']); assert.equal(report.orchestration.primaryComplete, false); conserved(report);
});

for (const scope of ['global', 'member']) test(scope + ' missing completion remains undeclared despite other completed declarations', async () => {
  const report = await run(value => { delete (scope === 'global' ? value : value.reviews[0]).completion; });
  assert.equal(report.status, 'partial'); assert.equal(report.orchestration.primaryComplete, false); assert.equal(report.orchestration.modelCompletionComplete, false); assert.ok(report.limitations.some(item => item.code === 'SINGLE_PASS_COMPLETION_UNDECLARED')); conserved(report);
});

test('fixed string and array limits accept exact boundaries without changing completion', () => {
  const value = empty({ input: JSON.stringify({ reviews: [{ fileId: 'f0' }] }) });
  value.assuranceNotes = Array(50).fill('note'); value.reviews[0].assuranceNotes = ['x'.repeat(8000)];
  assert.equal(normalizeSinglePassCompletion(value, ['f0']).complete, true);
  value.completion = { status: 'incomplete', gaps: ['x'.repeat(8000)] };
  assert.equal(normalizeSinglePassCompletion(value, ['f0']).complete, false);
});

test('normalization projects only old group schema and preserves declarations separately', () => {
  const value = empty({ input: JSON.stringify({ reviews: [{ fileId: 'f0' }] }) });
  const normalized = normalizeSinglePassCompletion(value, ['f0']);
  assert.deepEqual(Object.keys(normalized.response).sort(), ['limitations', 'reviews']); assert.deepEqual(Object.keys(normalized.response.reviews[0]).sort(), ['fileId', 'findings', 'limitations']); assert.equal(normalized.complete, true);
});
