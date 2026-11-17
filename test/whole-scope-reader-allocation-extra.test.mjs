import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const file = id => ({id,path:id+'.js',eligibility:'reviewable',properties:[],left:{text:'guard();\n'},right:{text:'unsafe();\n'+('x'.repeat(100)+'\n').repeat(210)}});
const snapshot={id:'reserve-extra',vcs:'git',context:[],files:[file('f')]};
const candidate={fileId:'f',severity:'medium',title:'Guard removed',evidence:'unsafe operation',trigger:'invalid state',impact:'failure',suggestion:'restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guarded',afterBehavior:'unguarded',reason:'guard removed'}};

test('greedy verifier cannot spend strict reread reserve; repeated deliveries are charged before successful strict comparison',async()=>{
 const scope=createRetrievalScope(snapshot,{maxCalls:12,maxOutputBytes:64*1024,reuseResults:true});
 let receipt, finalized=false;const delivered=[];
 const result=await verificationLoop(req=>{
  const input=JSON.parse(req.input);receipt??=input.retrieved.find(r=>r.result.receiptId).result.receiptId;
  if(!input.retrievalFinalization)return {requests:[{kind:'read',id:input.catalog.find(s=>s.side==='new').id,start:2,count:200}]};
  finalized=true;return {verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'Controlled evidence',evidence:[{receiptId:receipt}]}]};
 },{input:JSON.stringify({snapshotId:snapshot.id}),instructions:'verify'},[candidate],scope,{reserveFinalEvidence:true,maxRounds:6,maxInputBytes:1024*1024,onRetrieved:rows=>delivered.push(...rows)});
 assert.equal(finalized,true);assert.equal(result[0].evidence[0].status,'references-validated');
 assert.ok(scope.usage().outputBytes>delivered.reduce((n,row)=>n+row.resultBytes,0));
 assert.ok(scope.usage().outputBytes<=64*1024);assert.ok(scope.usage().calls<=12);
});

test('parallel child scopes share one primary pool and failed atomic transactions cannot spend the reserved floor',async()=>{
 const s={...snapshot,files:[file('a'),file('b')]};let disposed=0,finished=0;const roots=[];
 const report=await reviewWholeScope(s,()=>{throw new Error('direct forbidden');},{optimizeReviewCalls:true,maxInputBytes:40000,validateFindingResponse:validateFindings,wholeScopeConcurrency:2,createBatchModel:async()=>({
  runPrimary:async({request,scope})=>{
   roots.push(scope);const input=JSON.parse(request.input),source=scope.catalog().find(s=>s.side==='new');
   const before=scope.usage();assert.throws(()=>scope.transaction(()=>{scope.read({id:source.id,start:1,count:1});scope.read({id:'missing',start:1,count:1});}),/authorized/);assert.deepEqual(scope.usage(),before);
   await Promise.resolve();assert.ok(scope.budget().remainingOutputBytes>=Math.floor(256*1024*2/3));finished++;
   return {reviews:input.reviews.map(r=>({fileId:r.fileId,findings:[],limitations:[]})),limitations:[]};
  },dispose:async()=>{disposed++;}
 })});
 assert.equal(roots.length,2);assert.equal(roots[0],roots[1]);assert.equal(finished,2);assert.equal(disposed,2);
 assert.equal(report.readerUsage.calls,0);assert.equal(report.readerUsage.outputBytes,0);assert.equal(report.readerAllocation.releasedUnits,2);
});

test('cancellation joins allocated children without publishing rolled-back or late evidence as completion',async()=>{
 const controller=new AbortController();let disposed=0;
 const s={...snapshot,files:[file('a'),file('b')]};
 const report=await reviewWholeScope(s,()=>{}, {optimizeReviewCalls:true,maxInputBytes:40000,validateFindingResponse:validateFindings,signal:controller.signal,createBatchModel:async()=>({runPrimary:async({scope,request})=>{
  const source=scope.catalog().find(s=>s.side==='new');scope.read({id:source.id,start:1,count:1});controller.abort(new Error('stop'));
  return {reviews:JSON.parse(request.input).reviews.map(r=>({fileId:r.fileId,findings:[],limitations:[]})),limitations:[]};
 },dispose:async()=>{disposed++;}})});
 assert.equal(report.status,'cancelled');assert.equal(report.coverage.completed,0);assert.ok(disposed>0);assert.ok(report.readerUsage.calls<=50);assert.ok(report.readerUsage.outputBytes<=256*1024);
});
