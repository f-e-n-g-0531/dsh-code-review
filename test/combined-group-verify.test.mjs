import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot} from '../src/review.mjs';
test('grouped verification retrieval and coverage reconcile without widening budget',async()=>{
 const files=[
  {id:'f1',path:'a.cpp',eligibility:'reviewable',properties:[],left:{text:'void run() { consume(); }'},right:{text:'void run() { if (g) consume(); }'}},
  {id:'f2',path:'b.cpp',eligibility:'reviewable',properties:[],left:{text:'void work() { consume(); }'},right:{text:'void work() { consume(); log(); }'}},
 ];
 const s={id:'s',vcs:'git',files,context:[]};
 const r=await reviewSnapshot(s,req=>{const p=JSON.parse(req.input);if(p.candidates)return {verdicts:p.candidates.map(c=>({candidateId:c.candidateId,verdict:'uncertain',reason:'missing caller',evidence:[]}))};const fid=p.file?.id??p.files?.[0]?.fileId??'f1';return {findings:[{fileId:fid,severity:'high',title:'candidate',evidence:'Hypothesis, not proof',trigger:'trigger',impact:'failure',suggestion:'inspect callers',anchor:{kind:'file'}}],limitations:[]};},{enableGrouping:true,enableVerification:true,enableRetrieval:true,maxInputBytes:96000});
 const tally=Object.values(r.coverage).reduce((a,b)=>a+b,0);
 assert.equal(tally,files.length);
 assert.ok(r.files.every(f=>typeof f.initialInputBytes==='number'&&f.initialInputBytes<=96000));
 assert.ok(r.findings.length>0);
 assert.ok(r.findings.every(f=>f.verification&&f.verification.status));
 assert.notEqual(r.status,undefined);
});
