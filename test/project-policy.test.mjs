import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { createProjectReviewService } from '../src/project-review-service.mjs';
import { createReviewService } from '../src/service.mjs';
import { projectSnapshotIsCurrent } from '../src/project-snapshot.mjs';
import { projectPreviewFiles, reviewProjectBatches } from '../src/project-execution.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { reportSummaryData } from '../src/report-summary.mjs';

async function gitFixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-project-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await checked('git', ['init', '-q'], { cwd: root });
  for (const [name, source] of Object.entries(files)) await writeFile(path.join(root, name), source);
  await checked('git', ['add', '.'], { cwd: root });
  return { root, exec: { agent: { session: { header: { cwd: root } }, options: { provider: 'local', model: 'fixture' } } } };
}

function emptyReview() {
  return [{ type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) }, { type: 'finish', reason: { kind: 'stop' } }];
}

async function run(service, exec, args = {}) {
  const preview = await service.preview({ reviewMode: 'project', ...args }, exec);
  const { report } = await service.execute({ previewId: preview.previewId, confirmed: true }, exec);
  return { preview, report };
}

test('project input is bounded at 96KiB despite changes settings, including actual wire data', async t => {
  const { exec } = await gitFixture(t, { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2; /*' + '界'.repeat(34000) + '*/' });
  const sends = [];
  const service = createReviewService({ async *stream(request) {
    const input = request.messages[0].content[0].text;
    sends.push({ bytes: Buffer.byteLength(request.system) + Buffer.byteLength(input) + Buffer.byteLength(JSON.stringify(request.tools)), file: JSON.parse(input).file.path });
    yield* emptyReview();
  } }, { maxInputBytes: 512 * 1024, nativeOutputTools: true, enableGroupPrimary: true, allowModelSending: true, authorize: async () => true });
  t.after(() => service.dispose());
  const { preview, report } = await run(service, exec);
  for (const output of [preview, report]) {
    assert.equal(output.execution.maxInputBytes, 96 * 1024);
    assert.equal(output.execution.enableGroupPrimary, false);
  }
  assert.deepEqual(sends.map(send => send.file), ['a.js']);
  assert.equal(preview.files[0].initialInputBytes, sends[0].bytes);
  assert.equal(preview.files[0].initialInputFits, true);
  assert.equal(preview.files[1].initialInputFits, false);
  assert.ok(preview.files[1].initialInputBytes > 96 * 1024);
  assert.ok(sends[0].bytes <= 96 * 1024);
  assert.equal(report.modelCalls, 1);
  assert.equal(report.coverage.blocked, 1);
});

test('native preview and first send agree on both sides of the exact 96KiB boundary', async () => {
  const maxInputBytes = 96 * 1024;
  const options = { nativeOutputTools: true, maxInputBytes, maxRetrievalRounds: 3 };
  const fixture = n => ({ id: 'boundary', root: 'fixture', vcs: 'git', projectScope: { mode: 'project' }, context: [], files: [
    { id: 'file', path: 'file.js', eligibility: 'reviewable', reviewMode: 'project', properties: [], left: { text: '' }, right: { text: '/*' + 'x'.repeat(n) + '*/' } },
  ] });
  let lo = 1, hi = maxInputBytes;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (projectPreviewFiles(fixture(mid), options)[0].initialInputFits) lo = mid; else hi = mid;
  }
  const sends = [];
  const adapter = createDshModel({ async *stream(request) {
    sends.push(Buffer.byteLength(request.system) + Buffer.byteLength(request.messages[0].content[0].text) + Buffer.byteLength(JSON.stringify(request.tools)));
    yield* emptyReview();
  } }, { provider: 'local', model: 'fixture' });
  for (const [n, fits] of [[lo, true], [hi, false]]) {
    const batch = fixture(n);
    const [file] = projectPreviewFiles(batch, options);
    assert.equal(file.initialInputFits, fits);
    assert.ok(Math.abs(file.initialInputBytes - maxInputBytes) <= 16);
    const [report] = await reviewProjectBatches([batch], adapter, { ...options, remainingCalls: () => 10 });
    assert.equal(report.files[0].initialInputBytes, file.initialInputBytes);
    assert.equal(report.files[0].status, fits ? 'completed' : 'blocked');
    if (fits) assert.deepEqual(sends, [file.initialInputBytes]);
  }
  assert.equal(sends.length, 1);
});

test('project resume binding rejects a changed project input limit and accepts the exact same limit', async t => {
  const { exec } = await gitFixture(t, { 'a.js': 'const a = 1;\n' });
  const saved = [];
  const llm = { async *stream() { yield* emptyReview(); } };
  const common = { allowModelSending: true, authorize: async () => true };
  const normal = createProjectReviewService(llm, common);
  const lower = createProjectReviewService(llm, { ...common, projectMaxInputBytes: 64 * 1024 });
  t.after(() => { normal.dispose(); lower.dispose(); });
  const result = await run(normal, { ...exec, reviewResumeCheckpoint: state => saved.push(state) });
  assert.equal(result.report.coverage.completed, 1);
  assert.equal(saved.length, 2, 'per-file recovery and batch-final only; no duplicate service-level final export');
  const resumeFromJobId = '12345678-1234-1234-1234-123456789abc';
  const resumeExec = { ...exec, resolveReviewResume: () => saved.at(-1) };
  await assert.rejects(lower.preview({ reviewMode: 'project', resumeFromJobId }, resumeExec), /identity|binding|checkpoint/i);
  const resumed = await run(normal, resumeExec, { resumeFromJobId });
  assert.equal(resumed.preview.resume.reusableFiles, 1);
  assert.equal(resumed.report.resume.reusedFiles, 1);
  assert.equal(resumed.report.modelCalls, 0);
});

test('failed file contributes exactly once to project and presentation coverage', async t => {
  const { exec } = await gitFixture(t, { 'a.js': 'const a = 1;\n', '.env': 'IGNORE_ME = true' });
  const service = createProjectReviewService({ async *stream() { throw new Error('offline fixture failed'); } }, { allowModelSending: true, authorize: async () => true });
  t.after(() => service.dispose());
  const { report } = await run(service, exec);
  assert.deepEqual(report.coverage, { total: 2, completed: 0, excluded: 1, blocked: 0, failed: 1, cancelled: 0, pending: 0 });
  const summary = reportSummaryData(report).coverage;
  assert.equal(summary.failed, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.unaccounted, 0);
});

test('project final freshness compares every original batch twice but stops on the first mismatch', async () => {
  const approved = { root: 'root', vcs: 'git', inventoryId: 'index', batches: [
    { id: 'one', files: [{ path: 'a.js' }, { path: 'b.js' }] }, { id: 'two', files: [{ path: 'c.js' }] },
  ] };
  const options = { signal: new AbortController().signal };
  async function trace(mismatch) {
    let pass = 0;
    const events = [];
    const fresh = await projectSnapshotIsCurrent(approved, approved.root, approved.vcs, options, {
      inventory: async (root, vcs, actual) => {
        assert.equal(actual, options); assert.equal(root, approved.root); assert.equal(vcs, approved.vcs);
        events.push('inventory ' + ++pass);
        return { id: mismatch === 'inventory ' + pass ? 'changed' : 'index' };
      },
      batch: async (inventory, paths, actual) => {
        assert.equal(inventory.id, 'index'); assert.equal(actual, options);
        const key = pass + ' ' + paths.join(',');
        events.push(key);
        return { id: mismatch === key ? 'changed' : paths.length === 2 ? 'one' : 'two' };
      },
    });
    return { fresh, events };
  }
  assert.deepEqual(await trace(), { fresh: true, events: ['inventory 1', '1 a.js,b.js', '1 c.js', 'inventory 2', '2 a.js,b.js', '2 c.js'] });
  assert.deepEqual(await trace('1 a.js,b.js'), { fresh: false, events: ['inventory 1', '1 a.js,b.js'] });
  assert.deepEqual(await trace('inventory 2'), { fresh: false, events: ['inventory 1', '1 a.js,b.js', '1 c.js', 'inventory 2'] });
  assert.deepEqual(await trace('2 a.js,b.js'), { fresh: false, events: ['inventory 1', '1 a.js,b.js', '1 c.js', 'inventory 2', '2 a.js,b.js'] });
});

test('source change after approved execution is reported outdated, not accepted as a fresh result', async t => {
  const { root, exec } = await gitFixture(t, { 'a.js': 'const a = 1;\n' });
  const service = createProjectReviewService({ async *stream() { yield* emptyReview(); } }, { allowModelSending: true, authorize: async () => true });
  t.after(() => service.dispose());
  const result = await run(service, { ...exec, reviewCheckpoint: async event => {
    if (event.stage === 'source-freshness') await writeFile(path.join(root, 'a.js'), 'const a = 2;\n');
  } });
  assert.equal(result.report.coverage.completed, 1);
  assert.equal(result.report.outdated, true);
});

test('cancellation during final freshness retains completed file coverage', async t => {
  const { exec } = await gitFixture(t, { 'a.js': 'const a = 1;' });
  const controller = new AbortController();
  const service = createProjectReviewService({ async *stream() { yield* emptyReview(); } }, { allowModelSending: true, authorize: async () => true });
  t.after(() => service.dispose());
  const result = await run(service, { ...exec, signal: controller.signal, reviewCheckpoint: event => {
    if (event.stage === 'source-freshness') controller.abort(new Error('stop'));
  } });
  assert.equal(result.report.status, 'cancelled');
  assert.equal(result.report.coverage.completed, 1);
  assert.equal(result.report.coverage.pending, 0);
  assert.equal(result.report.outdated, true);
});

test('project preview availability is read-only and bound to owner and expiration', async t => {
  const { exec } = await gitFixture(t, { 'a.js': 'const a = 1;\n' });
  let now = 100;
  const service = createProjectReviewService({ async *stream() { yield* emptyReview(); } }, { now: () => now, ttlMs: 10 });
  t.after(() => service.dispose());
  const { previewId } = await service.preview({ reviewMode: 'project' }, exec);
  assert.equal(await service.previewAvailability(previewId, exec), 'available');
  assert.equal(await service.previewAvailability(previewId, { agent: { ...exec.agent } }), 'unavailable');
  assert.equal(await service.previewAvailability(previewId, exec), 'available');
  await assert.rejects(service.previewAvailability(previewId, { ...exec, signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  now = 110;
  assert.equal(await service.previewAvailability(previewId, exec), 'expired');
  assert.equal(service.owns(previewId), true);
});
