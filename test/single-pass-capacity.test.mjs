import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';

const snapshot = { id:'fixed', root:'/repo', vcs:'git', context:[], rules:[], files:[{ id:'f', path:'a.js', eligibility:'reviewable', left:{text:'old();'}, right:{text:'新();'}, properties:[] }] };
for (const [reason, code] of [
  [{ kind:'length' }, 'SINGLE_PASS_OUTPUT_LIMIT'],
  [{ kind:'error', failure:{ code:'CONTEXT_WINDOW_EXCEEDED', message:'private-provider-text' } }, 'SINGLE_PASS_CONTEXT_LIMIT'],
]) test(code + ' is actionable, never retried and not an accepted audit', async t => {
  let calls = 0;
  const service = createReviewService({ async *stream(request) {
    calls++;
    assert.equal(request.maxTokens, 2048);
    assert.deepEqual(request.tools, []);
    yield { type:'text-delta', text:'private-output' };
    yield { type:'finish', reason };
  } }, { executionStrategy:'auto', capture:async()=>snapshot, allowModelSending:true, authorize:async()=>true, resolveModelCapacity:async()=>({ contextWindowTokens:4096, maxOutputTokens:2048 }) });
  t.after(()=>service.dispose());
  const exec = { agent:{ session:{header:{cwd:'/repo'}}, options:{provider:'fixture',model:'offline'} }, signal:new AbortController().signal };
  const preview = await service.preview({}, exec);
  assert.deepEqual(preview.plan.capacity, { logicalBytes:'fits', modelContext:{ status:'unknown', contextWindowTokens:4096, inputTokens:null }, output:{ requestedTokens:2048, modelLimitTokens:2048, responseFits:'unknown' }, independentVerification:'not-requested' });
  assert.equal(calls, 0);
  const result = await service.execute({ previewId:preview.previewId, confirmed:true }, exec);
  assert.equal(calls, 1);
  assert.equal(result.report.failureCode, code);
  assert.equal(result.report.status, 'failed');
  assert.deepEqual(result.report.findings, []);
  assert.match(result.markdown, /重新预览/);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-text|private-output/);
});
