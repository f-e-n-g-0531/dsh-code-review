import { groupDuplicateFindings } from '../src/finding-groups.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, REVIEW_INSTRUCTIONS, markdownReport } from '../src/review.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { buildReviewGroups } from '../src/review-groups.mjs';
import { inferFileRelations } from '../src/file-relations.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { interactionCases } from './fixtures/interaction-cases.mjs';
const snapshot = (caseIndex = 0) => ({ id:'snap', vcs:'git', context:[], files: interactionCases[caseIndex].files.map((f,i) => ({ id:'f'+i, path:f.path, eligibility:'reviewable', properties:[], left:{text:f.old}, right:{text:f.new} })) });
const options = { enableRetrieval:true, enableGrouping:true };
test('interaction reads both files verifies primary before-after receipts and retains original qualified evidence', async () => {
 const s=snapshot(); let signals=new Map();
 const report=await reviewSnapshot(s, async r=>{
  const p=JSON.parse(r.input);
  if(p.file){signals.set(p.file.id,r.signal);return {findings:[],limitations:[]};}
  assert.equal(r.signal,signals.get('f1'));
  if(p.candidates){
   assert.equal(p.candidates[0].finding.interaction.editRefs.length,2);
   if(!p.retrieved.length)return {requests:[{kind:'read',id:'s3',start:2,count:1},{kind:'read',id:'s4',start:2,count:1}]};
   return {verdicts:[{candidateId:'c1',verdict:'supported',reason:'contract mismatch',evidence:p.retrieved.map(x=>({receiptId:x.result.receiptId})),regression:{classification:'introduced',reason:'old null guard/new undefined mismatch',oldEvidence:[0],newEvidence:[1]}}]};
  }
  assert.equal(p.sourceMode,'file-interaction');
  if(!p.retrieved.length)return {requests:[{kind:'read',id:'s2',start:1,count:1},{kind:'read',id:'s4',start:2,count:1}]};
  return {findings:[{fileId:'f1',severity:'high',title:'contract mismatch',evidence:'both edits',trigger:'missing lookup',impact:'TypeError',suggestion:'align guard',anchor:{kind:'line',side:'new',start:2,end:2,snippet:s.files[1].right.text.split(String.fromCharCode(10))[1]},attribution:{editIds:['e1'],properties:[],beforeBehavior:'safe',afterBehavior:'throw',reason:'undefined is not null'},interaction:{editRefs:[{fileId:'f0',editId:'e1'},{fileId:'f1',editId:'e1'}]}}],limitations:[]};
 },{...options,enableVerification:true});
 assert.equal(report.status,'completed'); assert.equal(report.modelCalls,6);
 assert.equal(report.interactions[0].status,'completed'); assert.equal(report.findings[0].verification.regression.classification,'introduced');
 assert.equal(report.findings[0].verification.evidence.length,2);
 assert.deepEqual(groupDuplicateFindings([report.findings[0],structuredClone(report.findings[0])]),[]);
 assert.match(markdownReport(report),/跨文件综合/);
});
test('safe fixture navigation excludes oracle and timeout waits for synthesis cleanup',async()=>{
 const safe=snapshot(1); let calls=0;
 const result=await reviewSnapshot(safe,async r=>{ calls++;assert.ok(!r.input.includes('no-defect'));return {findings:[],limitations:[]};},options);
 assert.equal(result.status,'completed');assert.equal(calls,3);assert.equal(result.findings.length,0);
 let cleaned=false;
 const timed=await reviewSnapshot(snapshot(),async r=>{
  if(JSON.parse(r.input).sourceMode!=='file-interaction')return {findings:[],limitations:[]};
  await new Promise(resolve=>r.signal.addEventListener('abort',resolve,{once:true}));cleaned=true;throw r.signal.reason;
 },{...options,timeoutMs:30});
 assert.ok(cleaned);assert.equal(timed.status,'partial');assert.equal(timed.interactions[0].status,'pending');
});
test('preview counts interaction and budget or cancellation retains independent pending coverage',async()=>{
 const s=snapshot(); const plan=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),grouping:buildReviewGroups(s.files,inferFileRelations(s.files)),maxInputBytes:96*1024});
 assert.equal(plan.minimumCalls,3);
 const exhausted=await reviewSnapshot(s,async()=>({findings:[],limitations:[]}),{...options,maxCalls:2});
 assert.equal(exhausted.modelCalls,2);assert.equal(exhausted.interactions[0].status,'pending');assert.equal(exhausted.status,'partial');
 const controller=new AbortController();
 const cancelled=await reviewSnapshot(s,async r=>{if(JSON.parse(r.input).sourceMode==='file-interaction'){controller.abort(Error('stop'));throw r.signal.reason;}return {findings:[],limitations:[]};},{...options,signal:controller.signal});
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.interactions[0].status,'pending');
});
