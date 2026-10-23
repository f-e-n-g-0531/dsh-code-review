import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { retrievalLoop } from '../src/retrieval-loop.mjs';
const options={enableRetrieval:true,optimizeReviewCalls:true,readerBudgetPolicy:'scaled',changesConcurrency:2,maxRetrievalRounds:3};
const make=(n=74)=>({id:'bounded-fixture',vcs:'git',files:Array.from({length:n},(_,i)=>({id:'f'+i,path:'f'+i+'.js',eligibility:'reviewable',properties:[],left:{text:'guard();'+String.fromCharCode(10)},right:{text:'unsafe();'+String.fromCharCode(10)}})),context:[{path:'shared.js',text:'function shared() { return 1; }'+String.fromCharCode(10)}]});
test('74-file production orchestration reuses an approved exact read without raising root caps',async()=>{
 const s=make();let requests=0;
 const r=await reviewSnapshot(s,request=>{const p=JSON.parse(request.input);if(!p.retrieved.length){requests++;return{requests:[{kind:'read',id:p.catalog.find(x=>x.path==='shared.js').id,start:1,count:1}]};}assert.equal(p.retrieved[0].result.text,s.context[0].text);return{findings:[],limitations:[]};},options);
 assert.equal(requests,74);assert.equal(r.coverage.completed,74);assert.equal(r.readerBudget.maxCalls,296);assert.equal(r.readerBudget.calls,1);assert.equal(r.readerBudget.cacheHits,73);assert.equal(r.readerBudget.deliveries,74);assert.equal(r.readerAllocation.releasedUnits,r.readerAllocation.units);assert.ok(r.readerBudget.outputBytes>74*20);assert.match(markdownReport(r),/缓存命中 73/);
});
test('cached read survives zero materialization calls but not output bytes or a different request',async()=>{
 const scope=createRetrievalScope(make(1),{reuseResults:true,maxCalls:1,maxOutputBytes:8192});const op={kind:'read',id:'s2',start:1,count:1};scope.read(op);let sends=0;
 const response=await retrievalLoop(request=>{sends++;const p=JSON.parse(request.input);assert.ok(!p.retrievalFinalization);return p.retrieved.length?{findings:[],limitations:[]}:{requests:[op]};},{instructions:'controlled',input:JSON.stringify({file:{path:'f0.js'}})},scope,{maxRounds:3});
 assert.equal(sends,2);assert.deepEqual(response,{findings:[],limitations:[]});assert.equal(scope.usage().calls,1);assert.equal(scope.usage().cacheHits,1);
 assert.throws(()=>scope.read({...op,count:2}),{code:'READER_CALL_BUDGET_EXCEEDED'});
});
test('shared grouped round limit preserves exact reason on every member and counts shared event once',async()=>{
 const s=make(2);let groupCalls=0;
 const r=await reviewSnapshot(s,request=>{const p=JSON.parse(request.input);if(request.reviewPhase==='file-interaction')return{findings:[],limitations:[]};groupCalls++;if(!p.retrievalFinalization)return{requests:[{kind:'read',id:'s2',start:1,count:1}]};return{reviews:p.reviews.map(row=>({fileId:row.fileId,findings:[],limitations:[],risks:[]})),limitations:[]};},{...options,enableBusinessGrouping:true,enableGroupPrimary:true,maxRetrievalRounds:1});
 assert.equal(groupCalls,2);assert.equal(r.coverage.pending,2);assert.ok(r.files.every(f=>f.failureCode==='RETRIEVAL_ROUND_BUDGET_EXCEEDED'));assert.ok(r.files.every(f=>f.groupRetrievalLimits?.[0].code==='RETRIEVAL_ROUND_BUDGET_EXCEEDED'));assert.equal(r.diagnostics.readerLimitReasons.find(x=>x.code==='RETRIEVAL_ROUND_BUDGET_EXCEEDED').calls,1);assert.doesNotMatch(markdownReport(r),/共享组末主文件超时/);
});
test('74-file greedy early stage cannot take future stages protected read capacity',async()=>{
 const s=make();let laterRead=false;
 const r=await reviewSnapshot(s,request=>{const p=JSON.parse(request.input);if(p.retrievalFinalization)return{findings:[],limitations:[]};if(p.file.id==='f0'&&!p.retrieved.length)return{requests:Array.from({length:8},(_,i)=>({kind:'find',query:'unique-'+i,limit:1}))};if(p.file.id==='f73'&&!p.retrieved.length)return{requests:[{kind:'read',id:p.catalog.find(x=>x.path==='shared.js').id,start:1,count:1}]};if(p.file.id==='f73')laterRead=true;return{findings:[],limitations:[]};},options);
 assert.equal(laterRead,true);assert.equal(r.files.at(-1).status,'completed');assert.ok(r.readerBudget.calls<=296);assert.ok(r.readerBudget.outputBytes<=r.readerBudget.maxOutputBytes);
});
test('74-file early greedy reads leave later candidate independent verification funded',async()=>{
 const s=make();let verified=false;
 const finding={fileId:'f73',severity:'high',title:'controlled',evidence:'controlled',trigger:'controlled',impact:'controlled',suggestion:'controlled',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guard',afterBehavior:'unsafe',reason:'changed'}};
 const r=await reviewSnapshot(s,request=>{const p=JSON.parse(request.input);if(request.reviewPhase==='verification') { const read=p.retrieved.find(row=>row.result.receiptId);if(!read)return{requests:[{kind:'read',id:p.catalog.find(row=>row.fileId==='f73'&&row.side==='new').id,start:1,count:1}]};verified=true;return{verdicts:[{candidateId:'c1',verdict:'refuted',reason:'controlled',evidence:[{receiptId:read.result.receiptId}]}]}; }
 if(p.retrievalFinalization)return{findings:[],limitations:[]};if(p.file.id==='f0'&&!p.retrieved.length)return{requests:Array.from({length:8},(_,i)=>({kind:'find',query:'early-'+i,limit:1}))};return{findings:p.file.id==='f73'?[finding]:[],limitations:[]};},{...options,enableVerification:true});
 assert.equal(verified,true);assert.equal(r.findings[0].verification.verdict,'refuted');assert.equal(r.readerAllocation.releasedUnits,r.readerAllocation.units);assert.ok(r.readerBudget.calls<296);
});
test('secondary budget failure retains completed windows rather than rewriting primary as failed',async()=>{
 const lines=Array.from({length:100},(_,i)=>'line'+i+'x'.repeat(200)),next=[...lines];next[10]='changed10';next[80]='changed80';
 const s={id:'windows',vcs:'git',files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:lines.join('\n')},right:{text:next.join('\n')}}],context:[]};
 let synthesis=false;const r=await reviewSnapshot(s,request=>{const p=JSON.parse(request.input);if(p.sourceMode==='window-synthesis'){synthesis=true;throw Object.assign(new Error('Reader call budget exceeded'),{code:'READER_CALL_BUDGET_EXCEEDED'});}return{findings:[],limitations:[]};},{...options,maxInputBytes:8000});
 assert.equal(synthesis,true);assert.equal(r.files[0].status,'completed');assert.equal(r.files[0].synthesisStatus,'failed');assert.equal(r.files[0].stageFailures[0].code,'READER_CALL_BUDGET_EXCEEDED');assert.equal(r.files[0].windowCoverage.pending.length,0);assert.equal(r.status,'partial');assert.equal(r.files[0].resumeEligible,false);
});
