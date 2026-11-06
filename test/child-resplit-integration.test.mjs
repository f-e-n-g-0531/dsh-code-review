import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
import { ChildInputCapacityError } from '../src/child-capacity-error.mjs';
const cap = 96 * 1024;
const snapshot = () => ({ id: 'resplit-fixed', vcs: 'git', root: '/repo', context: [], files: Array.from({ length: 5 }, (_, i) => ({ id: 'f' + i, path: 'src/' + i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'x'.repeat(18000) } })) });
const options = { maxInputBytes: cap, nativeOutputTools: true, validateFindingResponse: validateFindings, wholeScopeConcurrency: 2 };
const empty = request => ({ reviews: JSON.parse(request.input).reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [] })), limitations: [] });
const direct = () => assert.fail('direct primary fallback');

test('branded unsent parent is disposed before leaves; sent sibling is not replayed and cap/calls remain shared', async () => {
  const events = [], sends = [], caps = []; let parent;
  const report = await reviewWholeScope(snapshot(), direct, { ...options, createBatchModel: async ({ fileIds }) => {
    const id = fileIds.join(','); events.push('create:' + id);
    return { runPrimary: async ({ request, maxInputBytes, reserveModelCall }) => {
      caps.push(maxInputBytes);
      if (fileIds.length > 1) { parent = [...fileIds]; throw new ChildInputCapacityError(cap + 1, cap, { unsent: true }); }
      assert.ok(events.includes('dispose:' + parent.join(',')) || !parent.includes(fileIds[0]));
      reserveModelCall(); sends.push(fileIds[0]); return empty(request);
    }, dispose: async () => { events.push('dispose:' + id); } };
  } });
  assert.equal(report.coverage.completed, 5); assert.equal(report.modelCalls, 5);
  assert.deepEqual([...sends].sort(), ['f0', 'f1', 'f2', 'f3', 'f4']); assert.equal(new Set(sends).size, 5);
  assert.ok(caps.every(value => value === cap)); assert.ok(report.orchestration.capacityReplans.length > 0);
  assert.ok(report.orchestration.batches.some(row => row.status === 'split-before-send'));
  assert.deepEqual(report.files.map(row => row.fileId), ['f0', 'f1', 'f2', 'f3', 'f4']);
  for (const row of report.orchestration.batches.filter(row => row.parentBatchId)) assert.ok(events.indexOf('dispose:' + report.orchestration.batches.find(p => p.id === row.parentBatchId).fileIds.join(',')) < events.indexOf('create:' + row.fileIds.join(',')));
});
for (const kind of ['provider-shaped', 'already-sent']) test(kind + ' capacity error never authorizes split', async () => {
  let created = 0, calls = 0;
  const report = await reviewWholeScope(snapshot(), direct, { ...options, createBatchModel: async () => {
    created++;
    return { runPrimary: async ({ reserveModelCall }) => {
      if (kind === 'already-sent') { reserveModelCall(); calls++; throw new ChildInputCapacityError(cap + 1, cap, { unsent: false }); }
      throw Object.assign(new Error('untrusted provider overflow'), { code: 'WHOLE_SCOPE_INPUT_BUDGET', requiredBytes: cap + 1, approvedCap: cap, unsent: true });
    }, dispose: async () => {} };
  } });
  assert.equal(created, report.orchestration.batches.length); assert.equal(report.orchestration.capacityReplans, undefined);
  assert.equal(report.coverage.failed, 5); assert.equal(report.modelCalls, calls);
});
test('single-member genuine unsent overflow stops at failed leaf without increasing capacity', async () => {
  const report = await reviewWholeScope(snapshot(), direct, { ...options, createBatchModel: async () => ({ runPrimary: async ({ maxInputBytes }) => { assert.equal(maxInputBytes, cap); throw new ChildInputCapacityError(cap + 1, cap, { unsent: true }); }, dispose: async () => {} }) });
  assert.equal(report.coverage.failed, 5); assert.equal(report.coverage.completed, 0); assert.equal(report.modelCalls, 0);
  assert.equal(report.orchestration.batches.filter(row => row.fileIds.length === 1 && row.status === 'failed').length, 5);
});
test('cancellation in parent disposal prevents leaf admission and still joins owned cleanup', async () => {
  const controller = new AbortController(); let created = 0, disposed = 0;
  const report = await reviewWholeScope(snapshot(), direct, { ...options, wholeScopeConcurrency: 1, signal: controller.signal, createBatchModel: async () => {
    created++; return { runPrimary: async () => { throw new ChildInputCapacityError(cap + 1, cap, { unsent: true }); }, dispose: async () => { disposed++; controller.abort(new Error('cancel during disposal')); } };
  } });
  assert.equal(report.status, 'cancelled'); assert.equal(created, 1); assert.equal(disposed, 1); assert.equal(report.modelCalls, 0);
});
test('fatal parent cleanup stops recursive admission and preserves exact cleanup error', async () => {
  const fatal = new Error('parent cleanup failed'); let created = 0, disposed = 0;
  await assert.rejects(reviewWholeScope(snapshot(), direct, { ...options, wholeScopeConcurrency: 1, createBatchModel: async () => {
    created++; return { runPrimary: async () => { throw new ChildInputCapacityError(cap + 1, cap, { unsent: true }); }, dispose: async () => { disposed++; throw fatal; } };
  } }), error => error === fatal);
  assert.equal(created, 1); assert.equal(disposed, 1);
});
