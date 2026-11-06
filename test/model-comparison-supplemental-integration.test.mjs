import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { changeMap } from '../src/change-map.mjs';
const fn=name=>'function '+name+'()\n{\n  return true;\n}\n';
async function run({foreignDoc=false,docAsRole=false,wrongSide=false}={}){
 const files=[['oldEntry','entry-old.js',fn('OldEntry'),''],['oldDelegate','delegate-old.js',fn('OldDelegate'),''],['primary','entry-new.js','',fn('NewEntry')],['caller','caller.js',fn('Caller'),fn('Caller')]].map(([id,path,left,right])=>({id,path,eligibility:'reviewable',properties:[],left:{text:left},right:{text:right}}));
 const snapshot={id:'supplemental-comparison',vcs:'git',root:'/repo',files,context:[{path:'contract.md',text:'Counterevidence requirement\nUnrelated requirement\n'}]},scope=createRetrievalScope(snapshot),changes=changeMap('',fn('NewEntry'));
 const candidate={fileId:'primary',severity:'medium',anchor:{kind:'line',side:'new',start:3,end:3,snippet:'  return true;'},attribution:{status:'references-validated',editIds:changes.edits.map(e=>e.id)}};
 let calls=0;const received=[];
 const verdicts=await verificationLoop(request=>{
  calls++;const p=JSON.parse(request.input);assert.equal(p.modelComparisonPolicy.enabled,true);
  const sources=[['oldEntry','old'],['oldDelegate','old'],['primary','new'],['caller','old']].map(([fileId,side])=>p.catalog.find(s=>s.fileId===fileId&&s.side===side));sources.push(p.catalog.find(s=>s.path==='contract.md'));
  const refs=sources.map(source=>p.retrieved.find(row=>row.result.sourceId===source.id)?.result);
  if(refs.some(ref=>!ref))return{requests:sources.filter((_,i)=>!refs[i]).map(source=>({kind:'read',id:source.id,start:1,count:source.path==='contract.md'?1:source.lineCount}))};
  assert.equal(refs[4].count,1);assert.equal(sources[4].lineCount,2);assert.ok(refs.every(ref=>typeof ref.receiptId==='string'));received.push(...refs.map(ref=>ref.receiptId));
  return{verdicts:[{candidateId:p.candidates[0].candidateId,verdict:'supported',reason:'Model-assessed route with independently read supplementary counterevidence',evidence:refs.map((ref,i)=>({receiptId:i===4&&foreignDoc?'foreign-document-receipt':ref.receiptId})),regression:{classification:'introduced',reason:'Explicit route assessment',comparison:{kind:'model-assessed-cross-file',roles:{oldEntry:wrongSide?[2]:[0],oldDelegate:[1],newEntry:docAsRole?[4]:[2],callers:[3]},relationshipReason:'Compare the same trigger and retain contextual counterevidence'}}}]};
 },{input:JSON.stringify({snapshotId:snapshot.id}),instructions:'review'},[candidate],scope,{enableModelComparison:true,migrationSnapshot:snapshot,maxRounds:3});
 return{verdicts,calls,received};
}
test('partial approved document is retained as fresh supplemental evidence, not a complete role',async()=>{
 const {verdicts,calls,received}=await run(),v=verdicts[0];assert.equal(calls,2);assert.equal(received.length,5);assert.equal(new Set(received).size,5);
 assert.equal(v.evidence.length,5);assert.equal(v.evidence[4].text,'Counterevidence requirement\n');assert.equal(v.evidence[4].status,'references-validated');
 assert.equal(v.regression.status,'model-comparison-references-validated');assert.equal(v.regression.relationshipStatus,'model-assessed');assert.deepEqual(v.regression.oldEvidence,[0,1,3]);assert.deepEqual(v.regression.newEvidence,[2]);assert.ok(!v.regression.oldEvidence.includes(4)&&!v.regression.newEvidence.includes(4));
});
test('supplemental document still needs a current invocation receipt',async()=>{
 await assert.rejects(run({foreignDoc:true}),/Invalid evidence receipt/);
});
test('partial document cannot become the new-entry role and old role cannot borrow new-side evidence',async()=>{
 await assert.rejects(run({docAsRole:true}),error=>error.code==='INVALID_MODEL_COMPARISON'&&error.comparisonFailure==='role-completeness');
 await assert.rejects(run({wrongSide:true}),error=>error.code==='INVALID_MODEL_COMPARISON'&&error.comparisonFailure==='role-side');
});
