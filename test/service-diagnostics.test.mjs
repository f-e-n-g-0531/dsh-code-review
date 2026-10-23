import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
import { REVIEW_RUNTIME } from '../src/runtime-identity.mjs';
test('execute diagnostics expose loaded version and wall scope in report and rendered Markdown', async () => {
  let sends = 0, captures = 0;
  const service = createReviewService({ async *stream(request) { sends++; assert.deepEqual(request.tools, []); yield { type: 'text-delta', text: '{"findings":[],"limitations":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { capture: async () => { captures++; return { id: 'fixed', vcs: 'git', files: [{ id: 'f', path: 'a', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }], context: [] }; }, allowModelSending: true, authorize: async () => true });
  const exec = { agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'offline', model: 'fake' } }, signal: new AbortController().signal };
  try { const p = await service.preview({}, exec); assert.equal(sends, 0); const result = await service.execute({ previewId: p.previewId, confirmed: true }, exec);
    assert.equal(result.report.diagnostics.pluginVersion, REVIEW_RUNTIME.version);
    assert.ok(result.report.diagnostics.reviewWallMs >= 0);
    assert.ok(result.report.diagnostics.executionWallMs >= result.report.diagnostics.reviewWallMs);
    assert.equal(result.report.diagnostics.observedModelCalls, 1);
    assert.match(result.markdown, /执行诊断/); assert.match(result.markdown, /不含预览／用户确认等待/);
    assert.equal(sends, 1); assert.equal(captures, 3);
    assert.doesNotMatch(JSON.stringify(result.report.diagnostics), /modulePath|index[.]mjs|old|new/);
  } finally { service.dispose(); }
});
