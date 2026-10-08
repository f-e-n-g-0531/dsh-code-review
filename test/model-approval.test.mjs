import { createReviewService } from '../src/service.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModelApproval } from '../src/model-approval.mjs';
test('host denial diagnostics propagate through preview execute with zero model sends',async()=>{
 for(const outcome of ['rejected','cancelled','unavailable']){
  let sends=0;const agent={session:{header:{cwd:'/repo'}},options:{provider:'fake',model:'offline'}};const exec={agent,signal:new AbortController().signal};
  const service=createReviewService({async *stream(){sends++;}}, {capture:async()=>({id:'s',vcs:'git',root:'/repo',context:[],files:[{id:'f',path:'Skin.cpp',eligibility:'reviewable',properties:[],left:{text:'old'},right:{text:'new'}}]}),allowModelSending:true,authorize:async()=>requestModelApproval({request:async()=>outcome},{agent,signal:exec.signal})});
  const preview=await service.preview({},exec);await assert.rejects(service.execute({previewId:preview.previewId,confirmed:true},exec),new RegExp(outcome));assert.equal(sends,0);service.dispose();
 }
});
test('never policy diagnosis never grants or changes policy and still requests host once',async()=>{
 let asks=0;const session={};const approval={effectivePolicy:s=>{assert.equal(s,session);return 'never';},request:async()=>{asks++;return 'rejected';}};
 await assert.rejects(requestModelApproval(approval,{agent:{session}}),/policy=never.*full filesystem access does not grant model sending/);assert.equal(asks,1);
 assert.equal(await requestModelApproval({request:async()=> 'allowed-once',effectivePolicy:()=>{throw Error('not a gate');}},{}),true);
});
test('only literal host allowed-once grants and request identity signal remain intact',async()=>{
 const request={agent:{},signal:new AbortController().signal,toolName:'code_review_execute'};let seen;
 assert.equal(await requestModelApproval({request:async r=>{seen=r;return 'allowed-once';}},request),true);assert.equal(seen,request);
});
test('rejected cancelled unavailable missing and malformed outcomes fail closed with actionable diagnostics',async()=>{
 for(const outcome of ['rejected','cancelled','unavailable',true,undefined,'allowed-always'])await assert.rejects(requestModelApproval({request:async()=>outcome},{}),/no code sent.*review not performed/);
 await assert.rejects(requestModelApproval({},{}),/service missing/);
 await assert.rejects(requestModelApproval({request:async()=>{throw Error('host failure');}},{}),/host failure/);
});
