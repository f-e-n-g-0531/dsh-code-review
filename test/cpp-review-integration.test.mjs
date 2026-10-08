import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { buildReviewGroups } from '../src/review-groups.mjs';
import { inferFileRelations } from '../src/file-relations.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { cppLifecycleCases } from './fixtures/cpp-lifecycle-cases.mjs';
const snapshot=()=>({id:'cpp',vcs:'git',context:[],files:[{id:'a',path:'Skin.h',eligibility:'reviewable',properties:[],left:{text:'void Stop();'},right:{text:'void RequestStop();'}},{id:'b',path:'Skin.cpp',eligibility:'reviewable',properties:[],left:{text:cppLifecycleCases[0].old},right:{text:cppLifecycleCases[0].defect}}]});
const options={enableGrouping:true,enableRetrieval:true,enableVerification:true};
test('C++ named header implementation group carries call coordinates and exact cross-file receipt review',async()=>{
 const s=snapshot();let lastSignal;
 const plan=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),grouping:buildReviewGroups(s.files,inferFileRelations(s.files)),maxInputBytes:96*1024});assert.equal(plan.minimumCalls,3);
 const report=await reviewSnapshot(s,async r=>{const p=JSON.parse(r.input);
  if(p.file){if(p.file.id==='b'){lastSignal=r.signal;assert.equal(p.cppCallSites.find(c=>c.side==='new'&&c.expression==='worker.join').line,3);}return {findings:[],limitations:[]};}
  assert.equal(r.signal,lastSignal);
  if(p.candidates){if(!p.retrieved.length)return {requests:[{kind:'read',id:'s3',start:1,count:3},{kind:'read',id:'s4',start:1,count:3}]};return {verdicts:[{candidateId:'c1',verdict:'supported',reason:'abstract contract evidence',evidence:p.retrieved.map(x=>({receiptId:x.result.receiptId})),regression:{classification:'introduced',reason:'teardown before join',oldEvidence:[0],newEvidence:[1]}}]};}
  if(!p.retrieved.length)return {requests:[{kind:'read',id:'s2',start:1,count:1},{kind:'read',id:'s4',start:1,count:3}]};
  return {findings:[{fileId:'b',severity:'high',title:'early release',evidence:'both changes',trigger:'worker still active',impact:'use after free',suggestion:'join before release',anchor:{kind:'line',side:'new',start:2,end:2,snippet:'ReleaseState();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'join then release',afterBehavior:'release then join',reason:'abstract contract'},interaction:{editRefs:[{fileId:'a',editId:'e1'},{fileId:'b',editId:'e1'}]}}],limitations:[]};
 },options);
 assert.equal(report.status,'completed',JSON.stringify(report));assert.equal(report.modelCalls,6);assert.equal(report.interactions[0].status,'completed');assert.equal(report.findings[0].verification.evidence.length,2);
});
