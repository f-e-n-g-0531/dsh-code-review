import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
const cap = 98304;
const snapshot = () => ({ id: 'completion', vcs: 'git', root: '/repo', context: [], files: Array.from({ length: 5 }, (_, i) => ({ id: 'f'+i, path: i+'.js', eligibility:'reviewable', properties:[], left:{text:'guard();'}, right:{text:'unsafe();\n'+'x'.repeat(18000)} })) });
const opts = { maxInputBytes:cap, nativeOutputTools:true, validateFindingResponse:validateFindings, wholeScopeConcurrency:1 };
const empty = req => ({ reviews:JSON.parse(req.input).reviews.map(r=>({fileId:r.fileId,findings:[],limitations:[]})), limitations:[] });
const candidate = id => ({ fileId:id,severity:'medium',title:'Guard removed',evidence:'unsafe operation',trigger:'invalid state',impact:'failure',suggestion:'restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guarded',afterBehavior:'unguarded',reason:'guard removed'} });
function factory(events,{all=false,findings=false,repeat=false,ordinary=false,cleanup,controller}={}) {
  return async ({fileIds}) => {
    const id=fileIds.join(','); events.push('create:'+id);
    return {transport:'host-subagent',childId:id,runPrimary:async args=>{
      assert.equal(args.maxInputBytes,cap); args.reserveModelCall(); events.push('send:'+id);
      const limited=all||fileIds.length>1;
      if(limited){ if(!ordinary)args.onCapacityFinalOnly({code:'CHILD_FOLLOWUP_CAPACITY'}); args.onBudgetLimited({code:'CHILD_FOLLOWUP_CAPACITY',reason:'not delivered'}); }
      const value=empty(args.request);
      if(findings&&(limited||repeat))value.reviews[0].findings=[candidate(fileIds[0])];
      return value;
    },dispose:async()=>{events.push('dispose:'+id);if(fileIds.length>1){if(controller)controller.abort(new Error('cancel'));if(cleanup)throw cleanup;}}};
  };
}
const verify = req => ({verdicts:JSON.parse(req.input).candidates.map(c=>({candidateId:c.candidateId,verdict:'uncertain',reason:'Need independent evidence',evidence:[]}))});
test('paid fresh children complete only their leaves, preserve parent attempts and never rerun successful sibling',async()=>{
  const events=[], saved=[];
  const r=await reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:factory(events),onResumeCheckpoint:value=>saved.push(value)});
  assert.equal(r.coverage.completed,5);assert.equal(r.coverage.pending,0);assert.ok(r.modelCalls>5);
  const parents=r.orchestration.batches.filter(b=>b.status==='capacity-superseded');assert.ok(parents.length);
  for(const parent of parents){assert.equal(parent.childBatchIds.length,2);const children=parent.childBatchIds.map(id=>r.orchestration.batches.find(b=>b.id===id));assert.deepEqual(children.flatMap(b=>b.fileIds),parent.fileIds);for(const child of children){assert.equal(child.parentBatchId,parent.id);assert.ok(events.indexOf('dispose:'+parent.fileIds.join(','))<events.indexOf('create:'+child.fileIds.join(',')));}}
  assert.equal(events.filter(x=>x==='send:f4').length,1);
  for(const f of r.files){assert.equal(f.retrievalLimited,undefined);assert.ok(f.primaryAttempts.length);}
  assert.ok(r.files.some(f=>f.primaryAttempts.some(a=>a.retrievalLimited)));
  assert.ok(saved.some(s=>s.files.some(f=>f.status==='pending')));assert.equal(r.status,'partial');
});
test('parent candidate survives empty leaf and exact duplicate only merges provenance before fresh verification',async()=>{
  for(const repeat of [false,true]){
    const events=[];const r=await reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:factory(events,{findings:true,repeat})});
    const f0=r.findings.filter(f=>f.fileId==='f0');assert.equal(f0.length,1);assert.ok(f0[0].primaryOrigins.length>=(repeat?2:1));assert.equal(f0[0].verification.status,'completed');assert.equal(f0[0].verification.verdict,'uncertain');
    assert.equal(f0[0].evidence,'unsafe operation');
  }
});
test('ordinary budget code or model metadata does not authorize paid capacity completion',async()=>{
  const events=[];const r=await reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:factory(events,{ordinary:true})});
  assert.equal(r.orchestration.capacityCompletions,undefined);assert.ok(r.coverage.pending>0);assert.equal(events.filter(x=>x.startsWith('create:')).length,r.orchestration.batches.length);
});
test('single members remain pending and total attempts/depth stay bounded',async()=>{
  const events=[];const r=await reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:factory(events,{all:true})});
  assert.equal(r.coverage.pending,5);assert.equal(r.coverage.completed,0);assert.ok(r.modelCalls<=10);
  assert.ok(r.files.every(f=>Math.max(...f.primaryAttempts.map(a=>a.depth))<=8));
});
test('shared call cap prevents extra leaf admission without relabeling pending work',async()=>{
  const events=[];const r=await reviewWholeScope(snapshot(),verify,{...opts,maxCalls:1,createBatchModel:factory(events)});
  assert.equal(r.modelCalls,1);assert.equal(r.coverage.completed,0);assert.equal(r.coverage.pending,5);
});
test('checkpoint fatal prevents fresh leaf dispatch and preserves original error',async()=>{
  const fatal=new Error('checkpoint failed'),events=[];
  await assert.rejects(reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:factory(events),onResumeCheckpoint:()=>{throw fatal;}}),e=>e===fatal);
  assert.equal(events.filter(x=>x.startsWith('create:')).length,1);
  assert.equal(events.filter(x=>x.startsWith('dispose:')).length,1);
});
test('fresh attempts keep exact original member properties and share one approved reader',async()=>{
  const source=snapshot(),scopes=new Set(),seen=[];
  source.files[0].properties=[{name:'review:key',old:'old',new:'new'}];
  const r=await reviewWholeScope(source,verify,{...opts,createBatchModel:async({fileIds})=>({transport:'host-subagent',childId:fileIds.join(','),dispose:async()=>{},runPrimary:async args=>{
    args.reserveModelCall();scopes.add(args.scope);
    const payload=JSON.parse(args.request.input);
    for(const row of payload.reviews){const original=source.files.find(f=>f.id===row.fileId);assert.deepEqual(row.file,original);assert.equal(payload.snapshotId,source.id);seen.push(row.fileId);}
    if(fileIds.length>1){args.onCapacityFinalOnly({});args.onBudgetLimited({code:'CHILD_FOLLOWUP_CAPACITY',reason:'not delivered'});}
    return empty(args.request);
  }})});
  assert.equal(scopes.size,1);assert.equal(r.coverage.completed,5);assert.ok(seen.filter(id=>id==='f0').length>1);
});
test('shared reader exhaustion remains failed terminal leaf instead of fabricated completion',async()=>{
  let reads=0;
  const r=await reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:async({fileIds})=>({transport:'host-subagent',childId:fileIds.join(','),dispose:async()=>{},runPrimary:async args=>{
    args.reserveModelCall();
    if(fileIds.length>1){args.onCapacityFinalOnly({});args.onBudgetLimited({code:'CHILD_FOLLOWUP_CAPACITY',reason:'not delivered'});return empty(args.request);}
    reads++;throw Object.assign(new Error('reader exhausted'),{code:'READER_OUTPUT_BUDGET_EXCEEDED'});
  }})});
  assert.ok(reads>0);assert.equal(r.coverage.completed,0);assert.ok(r.coverage.failed>0);
});
test('cancellation or cleanup fatal after parent final stops new child creation',async()=>{
  const controller=new AbortController(),events=[];
  const r=await reviewWholeScope(snapshot(),verify,{...opts,signal:controller.signal,createBatchModel:factory(events,{controller})});
  assert.equal(r.status,'cancelled');assert.equal(events.filter(x=>x.startsWith('create:')).length,1);
  const fatal=new Error('cleanup fatal'), failed=[];
  await assert.rejects(reviewWholeScope(snapshot(),verify,{...opts,createBatchModel:factory(failed,{cleanup:fatal})}),e=>e===fatal);
  assert.equal(failed.filter(x=>x.startsWith('create:')).length,1);
});
