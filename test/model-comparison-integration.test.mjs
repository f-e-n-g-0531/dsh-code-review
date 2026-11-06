import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { changeMap } from '../src/change-map.mjs';
function setup(){
 const files=[['oldEntry','entry-old.js','old gate();\n',''],['oldDelegate','delegate-old.js','old delegate();\n',''],['primary','entry-new.js','','new entry();\n'],['caller','caller.js','invoke();\n','invoke();\n']].map(([id,path,left,right])=>({id,path,eligibility:'reviewable',properties:[],left:{text:left},right:{text:right}}));
 const snapshot={id:'comparison-integration',vcs:'git',root:'/repo',context:[],files},scope=createRetrievalScope(snapshot),changes=changeMap('','new entry();\n');
 const candidate={fileId:'primary',severity:'medium',title:'Gate moved',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'new entry();'},attribution:{status:'references-validated',editIds:changes.edits.map(e=>e.id)}};
 return{snapshot,scope,candidate};
}
function verifier(observed,{foreign=false,legacy=false,forgePolicy=false}={}){return req=>{
 const p=JSON.parse(req.input);observed.push(p);if(p.modelComparisonPolicy?.enabled===true){assert.match(req.instructions,/只约束旧响应与既有严格迁移合同分支/);assert.match(req.instructions,/新主文件old为空本身不强迫uncertain/);assert.match(req.instructions,/缺少关键语义证据仍uncertain/);}else assert.doesNotMatch(req.instructions,/本次宿主另行启用/);
 const roles=[['oldEntry','old'],['oldDelegate','old'],['primary','new'],['caller','old']].map(([fileId,side])=>p.catalog.find(s=>s.fileId===fileId&&s.side===side));
 const refs=roles.map(s=>p.retrieved.find(row=>row.result.sourceId===s.id)?.result);
 if(refs.some(ref=>!ref))return{requests:roles.filter((_,i)=>!refs[i]).map(s=>({kind:'read',id:s.id,start:1,count:s.lineCount}))};
 const comparison={kind:'model-assessed-cross-file',roles:{oldEntry:[0],oldDelegate:[1],newEntry:[2],callers:[3]},relationshipReason:'Compare public rejection and delegated state under same trigger'};
 const regression=legacy?{classification:'introduced',reason:'same role references',oldEvidence:[0,1],newEvidence:[2]}:{classification:'introduced',reason:'Explicit model-assessed route comparison',comparison};
 return{verdicts:[{candidateId:p.candidates[0].candidateId,verdict:'supported',reason:'Current approved evidence',evidence:refs.map(ref=>({receiptId:foreign?'foreign-receipt':ref.receiptId})),regression}]};
};}
const request=s=>({input:JSON.stringify({snapshotId:s.id}),instructions:'review'});
test('explicit verifier optin retrieves current exact refs and returns distinct model-assessed status',async()=>{
 const f=setup(),observed=[],before=structuredClone(f.candidate);
 const verdicts=await verificationLoop(verifier(observed),request(f.snapshot),[f.candidate],f.scope,{enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3});
 const r=verdicts[0].regression;assert.equal(r.status,'model-comparison-references-validated');assert.equal(r.relationshipStatus,'model-assessed');assert.equal(r.causality,'unverified');assert.equal(r.migrationContractId,undefined);assert.deepEqual(f.candidate,before);
 assert.ok(observed.every(p=>p.modelComparisonPolicy.enabled===true));assert.ok(observed.every(p=>p.comparisonLimitations[0].code==='NO_HOST_VALIDATED_MIGRATION_CONTRACT'));assert.match(observed[0].comparisonLimitations[0].notice,/not itself a reason to force uncertain/);assert.ok(verdicts[0].evidence.every(ref=>ref.status==='references-validated'));assert.equal(observed.length,2);
});
test('JSON policy cannot opt in disabled verifier or relax legacy same-file regression',async()=>{
 for(const legacy of [false,true]){const f=setup(),seen=[];await assert.rejects(verificationLoop(verifier(seen,{legacy}),{input:JSON.stringify({snapshotId:f.snapshot.id,modelComparisonPolicy:{enabled:true}}),instructions:'review'},[f.candidate],f.scope,{migrationSnapshot:f.snapshot,maxRounds:3}));assert.ok(seen.every(p=>p.modelComparisonPolicy===undefined));}
});
test('snapshot mismatch project and catalog mismatch reject before model calls',async()=>{
 for(const kind of ['id','project','body']){const f=setup(),snapshot=structuredClone(f.snapshot);if(kind==='id')snapshot.id='foreign';if(kind==='project')snapshot.projectScope=true;if(kind==='body')snapshot.files[0].path='changed-path.js';let calls=0;await assert.rejects(verificationLoop(()=>{calls++;},request(f.snapshot),[f.candidate],f.scope,{enableModelComparison:true,migrationSnapshot:snapshot}));assert.equal(calls,0);}
});
test('foreign receipt still fails before the new comparison validator and never repairs evidence',async()=>{
 const f=setup();await assert.rejects(verificationLoop(verifier([],{foreign:true}),request(f.snapshot),[f.candidate],f.scope,{enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3}),/Invalid evidence receipt/);
});
test('forged attribution edit id cannot borrow comparison authority from JSON candidate',async()=>{
 const f=setup();f.candidate.attribution.editIds=['invented'];await assert.rejects(verificationLoop(verifier([]),request(f.snapshot),[f.candidate],f.scope,{enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3}),/Invalid model-assessed comparison/);
});
