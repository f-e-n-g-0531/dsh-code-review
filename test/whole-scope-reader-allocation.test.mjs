import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

const snapshot = { id:'bounded',vcs:'git',context:[],files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'guard();\n'},right:{text:'unsafe();\n'+('x'.repeat(100)+'\n').repeat(210)}}] };
const finding={fileId:'f',severity:'medium',title:'Guard removed',evidence:'unsafe operation',trigger:'invalid state',impact:'failure',suggestion:'restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guarded',afterBehavior:'unguarded',reason:'guard removed'}};
const final = (input, evidence=[]) => ({verdicts:input.candidates.map(c=>({candidateId:c.candidateId,verdict:'uncertain',reason:'Controlled evidence is not causal proof',evidence}))});
const options={validateFindingResponse:validateFindings,optimizeReviewCalls:true,maxInputBytes:1024*1024,maxRetrievalRounds:20,maxVerificationRetrievalRounds:6};

test('greedy primary cannot consume verification reserve; fresh receipt and strict reread remain charged',async()=>{
 let primaryFinal=false, receipt;
 const report=await reviewWholeScope(snapshot,request=>{
  const input=JSON.parse(request.input);
  if(request.reviewPhase==='group-primary'){
   if(!input.retrievalFinalization)return {requests:[{kind:'read',id:input.catalog.find(s=>s.side==='new').id,start:2,count:200}]};
   primaryFinal=true;
   return {reviews:[{fileId:'f',findings:[finding],limitations:[]}],limitations:[]};
  }
  const seed=input.retrieved.find(r=>r.result.receiptId);assert.ok(seed);receipt=seed.result.receiptId;
  return final(input,[{receiptId:receipt}]);
 },options);
 assert.equal(primaryFinal,true);assert.ok(receipt);
 assert.equal(report.findings[0].verification.status,'completed');
 assert.equal(report.findings[0].verification.evidence[0].status,'references-validated');
 assert.equal(report.orchestration.batches[0].retrievalLimited,true);assert.equal(report.status,'partial');
 assert.ok(report.readerUsage.outputBytes<=256*1024);assert.ok(report.readerUsage.calls<=50);
 const audit=report.orchestration.verifications[0].retrievalAudit;assert.ok(audit.length>0);
 assert.equal(report.readerAllocation.releasedUnits,2);
 assert.equal(report.readerBudget.maxOutputBytes,256*1024);assert.equal(report.readerBudget.maxCalls,50);
 // Repeated primary delivery is charged; final strict re-read adds charged output
 // beyond all delivered retrieval audit (which excludes final validation).
 const delivered=report.orchestration.batches.flatMap(b=>b.retrievalAudit??[]).concat(audit).reduce((n,a)=>n+a.resultBytes,0);
 assert.ok(delivered>0);
 assert.ok(report.orchestration.batches.flatMap(b=>b.retrievalAudit??[]).reduce((n,a)=>n+a.resultBytes,0)<=256*1024-Math.floor(256*1024/3));
 assert.ok(report.readerUsage.outputBytes>delivered);
});

test('no candidates release the reserve without replaying primary; defaults remain unallocated',async()=>{
 for(const optimized of [true,false]){
  let calls=0;
  const report=await reviewWholeScope(snapshot,request=>{calls++;const input=JSON.parse(request.input);return {reviews:input.reviews.map(r=>({fileId:r.fileId,findings:[],limitations:[]})),limitations:[]};},{...options,optimizeReviewCalls:optimized});
  assert.equal(calls,1);assert.equal(report.readerUsage.outputBytes,0);
  if(optimized)assert.equal(report.readerAllocation.releasedUnits,2);else assert.equal(report.readerAllocation,undefined);
 }
});

test('verification retrieval preserves strict-validation calls; each invocation issues new receipts and rejects prior receipts',async()=>{
 const scope=createRetrievalScope(snapshot,{maxCalls:9,maxOutputBytes:64*1024});
 let firstReceipt;
 const request={input:JSON.stringify({snapshotId:snapshot.id}),instructions:'verify',signal:new AbortController().signal};
 const run=async foreign=>verificationLoop(req=>{
  const input=JSON.parse(req.input),seed=input.retrieved.find(r=>r.result.receiptId);
  assert.ok(seed);if(!firstReceipt)firstReceipt=seed.result.receiptId;
  return final(input,[{receiptId:foreign?firstReceipt:seed.result.receiptId}]);
 },request,[finding],scope,{reserveFinalEvidence:true,maxRounds:3,maxInputBytes:128*1024});
 const result=await run(false);assert.equal(result[0].evidence[0].status,'references-validated');
 const before=scope.usage();await assert.rejects(run(true),e=>e.code==='INVALID_EVIDENCE_RECEIPT');
 assert.ok(scope.usage().calls>before.calls);assert.ok(scope.usage().outputBytes>before.outputBytes);
});

test('strict final evidence overload never becomes completed and cancellation preserves the shared ledger',async()=>{
 const scope=createRetrievalScope(snapshot,{maxCalls:4,maxOutputBytes:64*1024});
 const request={input:JSON.stringify({snapshotId:snapshot.id}),instructions:'verify'};
 await assert.rejects(verificationLoop(req=>{const input=JSON.parse(req.input);const receipt=input.retrieved.find(r=>r.result.receiptId).result.receiptId;return final(input,Array.from({length:8},()=>({receiptId:receipt})));},request,[finding],scope,{reserveFinalEvidence:true,maxRounds:3}),e=>e.code==='READER_CALL_BUDGET_EXCEEDED');
 assert.equal(scope.usage().calls,4);assert.equal(scope.budget().maxCalls,4);
 const controller=new AbortController();
 const root=createRetrievalScope(snapshot,{maxCalls:10});
 await assert.rejects(verificationLoop(()=>{controller.abort(new Error('stop'));return {};},{...request,signal:controller.signal},[finding],root,{reserveFinalEvidence:true,maxRounds:3}),/stop/);
 assert.ok(root.usage().calls<=10);assert.equal(root.budget().maxCalls,10);
});
