import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
import { buildResumeState, validateResumeState } from '../src/review-resume.mjs';
const snapshot = () => ({id:'primary-yield',vcs:'git',context:[],files:['a','b','c'].map(id=>({id,path:id+'.js',eligibility:'reviewable',properties:[],left:{text:'guard();\n'},right:{text:'unsafe();\n'}}))});
const options={enableRetrieval:true,enableStageContinuation:true,readerBudgetPolicy:'fixed',changesConcurrency:1,maxRetrievalRounds:10,timeoutMs:5000};
const batch = prefix => ({requests:Array.from({length:8},(_,i)=>({kind:'find',query:prefix+i,limit:1}))});
test('primary resumes pending retrieval rather than replaying initial generation after peer floors release',async()=>{
 const calls=[]; let turns=0;
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);calls.push([p.file.id,request.callPurpose]);
  if(p.file.id==='a' && ++turns<=3)return batch('miss-'+turns+'-');
  return {findings:[],limitations:[]};
 },options);
 assert.equal(calls.filter(([id,purpose])=>id==='a'&&purpose==='primary-initial').length,1);
 assert.equal(calls.filter(([id])=>id==='b').length,1);assert.equal(calls.filter(([id])=>id==='c').length,1);
 assert.equal(report.stageContinuation.completed,1);assert.equal(report.stageContinuation.pending,0);
 assert.ok(report.files.every(f=>f.status==='completed'));assert.equal(report.readerBudget.maxCalls,50);assert.equal(report.readerBudget.calls,24);
});
const candidate = () => ({fileId:'a',severity:'high',title:'Guard removed',evidence:'Unsafe operation',trigger:'bad state',impact:'failure',suggestion:'restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guarded',afterBehavior:'unguarded',reason:'removed guard'}});
test('accepted first round and its finding survive a later primary yield without regeneration',async()=>{
 const calls=[];let primaryTurns=0,starts=0,verifications=0;
 const s=snapshot();
 const report=await reviewSnapshot(s,async request=>{
  const p=JSON.parse(request.input);calls.push([p.file?.id,request.reviewPhase,request.callPurpose]);
  if(request.reviewPhase==='verification'){
   verifications++;const receipt=p.retrieved.find(row=>row.result.receiptId)?.result.receiptId;assert.ok(receipt);
   return {verdicts:[{candidateId:'c1',verdict:'supported',reason:'Fresh independent evidence',evidence:[{receiptId:receipt}]}]};
  }
  if(p.file.id!=='a')return {findings:[],limitations:[]};
  if(request.callPurpose==='primary-initial')starts++;
  if(++primaryTurns===1)return {findings:[candidate()],limitations:[]};
  if(primaryTurns<=4)return batch('round2-'+primaryTurns+'-');
  return {findings:[],limitations:[]};
 },{...options,reviewRounds:2,enableVerification:true});
 assert.equal(starts,2);assert.equal(verifications,1);assert.equal(report.findings.length,1);assert.equal(report.findings[0].verification.status,'completed');
 assert.equal(report.stageContinuation.completed,1);assert.ok(report.files.every(f=>f.status==='completed'));
 assert.equal(report.stageGenerations.filter(g=>g.fileId==='a').length,2);assert.ok(report.readerBudget.calls<=50);
 const saved=JSON.parse(JSON.stringify(buildResumeState(s,{...options,reviewRounds:2,enableVerification:true},report)));
 assert.doesNotMatch(JSON.stringify(saved),/receiptId/);validateResumeState(saved,s,{...options,reviewRounds:2,enableVerification:true});
});
test('resumed primary retains its separate risk plan and only plans once',async()=>{
 let plans=0,turns=0;const seen=[];
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);
  if(request.reviewPhase==='risk-planning'){
   plans++;return {risks:[{id:'risk-'+p.file.id,fileIds:[p.file.id],editRefs:[{fileId:p.file.id,editId:p.changes.edits[0].id}],question:'Could guard removal fail?',trigger:'bad state',impact:'failure',checks:['check guard'],sourceIds:[]}]};
  }
  if(p.file.id==='a'){seen.push(p.riskPlan);if(++turns<=3)return batch('risk-'+turns+'-');}
  return {findings:[],limitations:[]};
 },{...options,enableRiskPlanning:true});
 assert.equal(plans,3);assert.ok(seen.length>3);assert.ok(seen.every(plan=>plan?.[0]?.id==='risk-a'));
 const state=report.files.find(f=>f.fileId==='a');assert.equal(state.riskPlans.length,1);assert.equal(state.riskPlans[0].status,'completed');assert.equal(state.riskPlans[0].generations.length,1);
 assert.equal(report.stageContinuation.completed,1);
});
test('primary continuation preserves retrieval rounds and cannot convert round exhaustion into completion',async()=>{
 let turns=0,initial=0;
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);if(p.file.id!=='a')return {findings:[],limitations:[]};
  if(request.callPurpose==='primary-initial')initial++;
  if(p.retrievalFinalization)return {findings:[],limitations:['round cap']};
  return batch('bounded-'+(++turns)+'-');
 },{...options,maxRetrievalRounds:3});
 assert.equal(initial,1);assert.equal(turns,3);assert.equal(report.readerBudget.calls,24);
 assert.equal(report.status,'partial');assert.equal(report.files.find(f=>f.fileId==='a').retrievalLimited,true);assert.equal(report.stageGenerations.some(g=>g.fileId==='a'),false);
});
test('disabled primary continuation retains legacy finalization and never retries a stage',async()=>{
 let initial=0,turns=0;
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);if(p.file.id!=='a')return {findings:[],limitations:[]};
  if(request.callPurpose==='primary-initial')initial++;
  if(p.retrievalFinalization)return {findings:[],limitations:['budget limited']};
  return batch('disabled-'+(++turns)+'-');
 },{...options,enableStageContinuation:false});
 assert.equal(initial,1);assert.equal(report.stageContinuation,undefined);assert.equal(report.status,'partial');assert.ok(report.readerBudget.calls<=50);
});
test('exhausted root or model-call budget leaves primary pending and preserves accepted peer generations',async()=>{
 for(const maxCalls of [4,100]){
  let turns=0;const report=await reviewSnapshot(snapshot(),async request=>{
   const p=JSON.parse(request.input);if(p.file.id==='a')return batch('root-'+(++turns)+'-');
   return {findings:[],limitations:[]};
  },{...options,maxCalls});
  assert.equal(report.status,'partial');assert.equal(report.stageContinuation.pending,1);assert.ok(report.stageContinuation.attempts<=2);
  assert.ok(report.readerBudget.calls<=50);assert.ok(report.modelCalls<=maxCalls);assert.equal(report.stageGenerations.some(g=>g.fileId==='a'),false);
 }
});
test('several deferred rounds share one primary allocation without replay or premature release',async()=>{
 let starts=0,turns=0;
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);if(p.file.id==='a'){
   if(request.callPurpose==='primary-initial')starts++;
   if(++turns<=3)return batch('siblings-'+turns+'-');
  }
  return {findings:[],limitations:[]};
 },{...options,reviewRounds:3});
 assert.equal(starts,3);assert.equal(report.stageContinuation.completed,3);assert.ok(report.files.every(f=>f.status==='completed'));
 assert.equal(report.stageGenerations.filter(g=>g.fileId==='a').length,3);assert.equal(report.readerBudget.calls,24);
});
test('cancellation during resumed primary keeps exact reason and never accepts the response',async()=>{
 const controller=new AbortController(),reason=new Error('cancel resumed primary');let turns=0;
 await assert.rejects(reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);if(p.file.id!=='a')return {findings:[],limitations:[]};
  if(++turns<=3)return batch('cancel-'+turns+'-');
  controller.abort(reason);return {findings:[candidate()],limitations:[]};
 },{...options,signal:controller.signal}),error=>error===reason);
 assert.equal(controller.signal.reason,reason);
});
