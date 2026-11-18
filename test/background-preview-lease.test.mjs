import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {registerBackgroundReview} from '../src/background-review.mjs';
import {createReviewService} from '../src/service.mjs';

test('background terminal status and wait require a fresh preview after expiry, consumption, eviction, or restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-bg-preview-lease-'));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await rm(directory, {recursive: true, force: true}); });
  const cwd = path.join(os.tmpdir(), 'review-lease-workspace');
  const exec = {agent: {session: {header: {id: 'lease', cwd}}, options: {provider: 'offline', model: 'fake'}}};
  let now = 10000, approvalCalls = 0, sends = 0;
  const create = () => createReviewService({async *stream() { sends++; throw new Error('No model send allowed'); }}, {
    now: () => now, ttlMs: 100, maxPreviews: 1, allowModelSending: true, executionStrategy: 'staged',
    authorize: async () => { approvalCalls++; return false; },
    capture: async root => ({id: 'lease-snapshot', vcs: 'git', root, files: [], context: []}),
  });
  const register = service => {
    const definitions = new Map();
    const jobs = registerBackgroundReview({tools: {register: d => definitions.set(d.name, d)}, on() {}}, service, {directory});
    cleanup.push(async () => { await jobs.dispose(); service.dispose(); });
    return (kind, args) => definitions.get('code_review_' + kind).execute(args, exec);
  };
  const service = create(), call = register(service);
  const preview = async () => {
    const {jobId} = JSON.parse((await call('start', {phase: 'preview'})).json);
    const value = JSON.parse((await call('wait', {jobId, waitFor: 'terminal'})).json);
    assert.equal(value.status, 'completed');
    assert.equal(value.previewAvailability, 'available');
    assert.match(value.nextAction, /without asking again/);
    return {jobId, previewId: value.resultSummary.previewId};
  };
  const unavailable = async (call, p, state) => {
    for (const [kind, fields] of [['status', {}], ['wait', {waitFor: 'terminal'}], ['status', {checkpointIndex: 0}]]) {
      const output = await call(kind, {jobId: p.jobId, ...fields}), value = JSON.parse(output.json);
      assert.equal(value.status, 'completed');
      assert.equal(value.previewAvailability, state);
      assert.match(value.nextAction, /fresh preview/);
      assert.ok(!output.json.includes(p.previewId));
      assert.match(output.markdown, /请重新预览并核对当前明确授权/);
      assert.doesNotMatch(output.markdown, /直接以 confirmed=true/);
    }
  };
  const expired = await preview(); now += 100; await unavailable(call, expired, 'expired');
  const consumed = await preview();
  await assert.rejects(service.execute({previewId: consumed.previewId, confirmed: true}, exec), /approval denied or unavailable/);
  await unavailable(call, consumed, 'unavailable');
  const evicted = await preview(), latest = await preview();
  await unavailable(call, evicted, 'unavailable');
  await unavailable(register(create()), latest, 'unavailable');
  assert.equal(JSON.parse((await call('status', {jobId: latest.jobId})).json).previewAvailability, 'available');
  assert.equal(approvalCalls, 1, 'status and wait never authorize');
  assert.equal(sends, 0);
  const controller = new AbortController(), abort = new Error('stop during availability check');
  exec.signal = controller.signal;
  const abortedCall = register({previewAvailability() { controller.abort(abort); throw abort; }, dispose() {}});
  await assert.rejects(abortedCall('status', {jobId: latest.jobId}), error => error === abort);
});
