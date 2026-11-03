import test from 'node:test';
import assert from 'node:assert/strict';
import { previewValidity } from '../src/preview-validity.mjs';
import { createReviewService } from '../src/service.mjs';
import { createProjectReviewService } from '../src/project-review-service.mjs';

test('project service uses the same explicit expiry and route diagnostics', async () => {
  const service = createProjectReviewService({}, { allowModelSending: true });
  const exec = { agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'test', model: 'm' } } };
  await assert.rejects(service.execute({previewId:'missing',confirmed:true},exec), {code:'PREVIEW_MISSING'});
  service.dispose();
});

const current = () => ({ agent: {}, cwd: '/repo', route: { provider: 'test', model: 'm' } });
test('preview validity distinguishes failure without restoring confirmation', () => {
  const owner = current(), preview = { ...owner, expires: 100 };
  assert.doesNotThrow(() => previewValidity(preview, owner, 99));
  for (const [p, who, clock, code] of [
    [undefined, owner, 0, 'PREVIEW_MISSING'], [preview, owner, 100, 'PREVIEW_EXPIRED'],
    [preview, { ...owner, agent: {} }, 0, 'PREVIEW_OWNER_CHANGED'],
    [preview, { ...owner, cwd: '/other' }, 0, 'PREVIEW_DIRECTORY_CHANGED'],
    [preview, { ...owner, route: { provider: 'test', model: 'other' } }, 0, 'PREVIEW_MODEL_CHANGED'],
  ]) assert.throws(() => previewValidity(p, who, clock), error => error.code === code && /fresh confirmation/.test(error.message));
});
test('authorization wait cancellation and route changes cannot send model input', async () => {
  for (const change of ['cancel','route']) {
    let entered, release, sends = 0;
    const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
    const controller = new AbortController();
    const service = createReviewService({ async *stream() { sends++; } }, { allowModelSending:true,
      capture:async()=>({id:'fixed',root:'/repo',vcs:'git',files:[],context:[]}), authorize:async()=>{ entered(); await gate; return true; } });
    const exec = {signal:controller.signal,agent:{session:{header:{cwd:'/repo'}},options:{provider:'p',model:'m'}}};
    const p = await service.preview({},exec), running = service.execute({previewId:p.previewId,confirmed:true},exec);
    await ready; if(change==='cancel') controller.abort(new Error('cancel approval')); else exec.agent.options.model='changed';
    release(); await assert.rejects(running, change==='cancel' ? /cancel approval/ : /Agent changed during approval/);
    assert.equal(sends,0); service.dispose();
  }
});

test('changes preview discloses expiry and rejects at boundary before recapture/model', async () => {
  let clock = 1000, captures = 0, models = 0;
  const service = createReviewService({ async *stream() { models++; } }, {
    now: () => clock, ttlMs: 100, allowModelSending: true, authorize: async () => true,
    capture: async () => { captures++; return { id: 'fixed', vcs: 'git', root: '/repo', files: [], context: [] }; },
  });
  const exec = { agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'test', model: 'm' } } };
  const p = await service.preview({}, exec);
  assert.equal(p.validForMs, 100); assert.equal(p.expiresAt, new Date(1100).toISOString());
  clock = 1100;
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, exec), { code: 'PREVIEW_EXPIRED' });
  assert.equal(captures, 1); assert.equal(models, 0);
  await assert.rejects(service.execute({ previewId: p.previewId, confirmed: true }, exec), { code: 'PREVIEW_MISSING' });
});
