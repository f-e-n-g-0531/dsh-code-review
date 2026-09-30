import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
const snapshot = () => ({ id: 'fixed', vcs: 'git', root: '/repo', files: [{ id: 'f', path: 'a', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }], context: [] });
const exec = () => ({ agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'test', model: 'model' } }, signal: new AbortController().signal });
const llm = { async *stream() { yield { type: 'text-delta', text: '{"findings":[],"limitations":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
test('preview does not call model; confirmed execution returns report', async () => {
  const service = createReviewService(llm, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => true });
  const e = exec(), p = await service.preview({}, e);
  assert.equal(p.model.provider, 'test');
  const result = await service.execute({ previewId: p.previewId, confirmed: true }, e);
  assert.equal(result.report.status, 'completed'); assert.equal(result.report.outdated, false);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /Preview/);
});
test('foreign owner, changed cwd, expired preview and unconfirmed execution fail', async () => {
  let time = 0;
  const service = createReviewService(llm, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => true, now: () => time });
  const e = exec(), p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, exec()), /owner/);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: false }, e), /Confirmed/);
  e.agent.session.header.cwd = '/other';
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /directory/);
  e.agent.session.header.cwd = '/repo'; time = 300001;
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /expired/);
});
test('source changes invalidate preview before model call', async () => {
  let count = 0;
  const service = createReviewService({ stream() { assert.fail('no model call'); } }, { capture: async () => ({ ...snapshot(), id: String(++count) }), allowModelSending: true, authorize: async () => true });
  const e = exec(), p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /Files changed/);
});
test('approval denial prevents model sending despite confirmed argument', async () => {
  const service = createReviewService({ stream() { assert.fail('must not send'); } }, { capture: async () => snapshot(), allowModelSending: true, authorize: async () => false });
  const e = exec(), p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /approval denied/);
});

test('disposing cancels in-flight capture and rejects future calls', async () => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const service = createReviewService(llm, { capture: async (_cwd, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const pending = service.preview({}, exec());
  await ready; service.dispose();
  await assert.rejects(pending, /disposed/);
  await assert.rejects(service.preview({}, exec()), /disposed/);
});

test('model sending is disabled by default', async () => {
  const service = createReviewService(llm, { capture: async () => snapshot() }); const e = exec();
  const p = await service.preview({}, e);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, e), /disabled/);
});
