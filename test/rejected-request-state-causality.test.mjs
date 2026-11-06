import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { prepareMigrationRegression } from '../src/migration-regression.mjs';
import { validateCandidateVerification } from '../src/candidate-verification.mjs';

// Executable behavior model only: not an AI reviewer or engine/runtime benchmark.
function behavior(current) {
  const state={value:0},pending=[];
  const mapped=id=>id==='known';
  return { state, request(id,value) {
    if(current)state.value=value;
    if(!mapped(id))return false;
    if(!current)state.value=value;
    pending.push(()=>state.value);return true;
  },completeFirst:()=>pending.shift()() };
}
function proof() {
  const old='#include "Gate.h"\n#include "Worker.h"\nvoid Gate::Run(Worker& worker, int value) {\n  if (value < 0) { return; }\n  worker.Run(value);\n}\n';
  const current='#include "Gate.h"\nvoid Gate::Run(Worker& worker, int value) {\n  shared = value;\n  if (value < 0) { return; }\n}\n';
  const baseline='#include "Worker.h"\nvoid Worker::Run(int value) {\n  shared = value;\n  if (value < 0) { return; }\n}\n';
  const file=(id,path,left,right)=>({id,path,eligibility:'reviewable',properties:[],left:{text:left},right:{text:right}});
  const header=(name,method)=>'class '+name+' {\npublic:\n void '+method+';\n int shared;\n};\n';
  const snapshot={id:'generic-state-gate',files:[file('gate','Gate.cpp',old,current),file('worker','Worker.cpp',baseline,baseline)],context:[['Gate.h',header('Gate','Run(Worker& worker, int value)')],['Worker.h',header('Worker','Run(int value)')]].map(([path,text])=>({path,text,oldText:text,oldRevision:'b',revision:'t'})),history:{base:'b',target:'t'}};
  const contract=buildMigrationContracts(snapshot).contracts.find(c=>c.kind==='old-delegation');assert.ok(contract);
  const scope=createRetrievalScope(snapshot),receipts=createEvidenceReceipts(scope.read),role=contract.new[0];
  const candidate={fileId:'gate',anchor:{kind:'line',side:'new',start:role.line,end:role.line},attribution:{status:'references-validated',editIds:role.editIds}};
  const context=prepareMigrationRegression(snapshot,scope,[contract],[candidate]);
  const refs=[contract.old[0],contract.new[0],contract.baseline[0]].map(r=>({receiptId:receipts.read({id:r.sourceId,start:r.startLine,count:r.endLine-r.startLine+1}).receiptId}));
  const verdict={candidateId:'c1',verdict:'supported',reason:'Rejected input changes state consumed by pending work',evidence:refs,regression:{classification:'introduced',reason:'Old public gate precedes delegation; current gate follows mutation',oldEvidence:[0,2],newEvidence:[1],migrationContractId:contract.id}};
  const validate=()=>validateCandidateVerification({verdicts:[verdict]},['c1'],scope.read,receipts.resolve,{enableMigrationRegression:true,migrationContext:context,catalog:scope.catalog(),fileIds:{c1:'gate'}});
  return{contract,scope,receipts,verdict,validate};
}
test('nonempty unmapped rejected B changes pending A only after validation-order regression',()=>{
  const old=behavior(false),current=behavior(true);
  for(const system of [old,current]){assert.equal(system.request('known',10),true);assert.equal(system.request('unmapped',20),false);}
  assert.equal(old.completeFirst(),10);assert.equal(current.completeFirst(),20);
  const p=proof(),result=p.validate()[0];assert.equal(p.contract.baseline.length,1);assert.equal(result.regression.classification,'introduced');assert.equal(result.regression.status,'comparison-references-validated');assert.equal(result.causality,'unverified');
});
test('accepted overlapping B is an existing shared-state counterexample, not the rejected-B comparison',()=>{
  for(const current of [false,true]){const system=behavior(current);assert.equal(system.request('known',10),true);assert.equal(system.request('known',20),true);assert.equal(system.completeFirst(),20);}
});
test('null-specific macro behavior remains unknown and cannot establish a supported defect',()=>{
  const evaluateNull = capturedMacro => capturedMacro===undefined ? {verdict:'uncertain',reason:'Null guard macro is not captured'} : {verdict:'uncertain',reason:'Additional route proof required'};
  assert.equal(evaluateNull(undefined).verdict,'uncertain');
  const p=proof();p.verdict.verdict='uncertain';p.verdict.reason='Null-specific macro semantics are not captured';p.verdict.evidence=[];p.verdict.regression={classification:'uncertain',reason:'No null-path conclusion',oldEvidence:[],newEvidence:[],migrationContractId:p.contract.id};
  assert.equal(p.validate()[0].verdict,'uncertain');
});
test('a helper false return does not establish caller rejection through an unknown guard',()=>{
  const outcomes=[];
  for(const guard of [()=>false,()=>{throw new Error('stop execution');},()=>true]){
    const state={value:10};
    const caller=()=>{state.value=20;const found=false;if(!guard(found))return false;return 'continued';};
    try{outcomes.push(caller());}catch{outcomes.push('aborted');}
    assert.equal(state.value,20);
  }
  assert.deepEqual(outcomes,[false,'aborted','continued']);
  // Mutation order is established, but continuation/rejection needs guard semantics.
});

test('explicit contract allowing rejected-operation side effects is semantic context, not automatic bug authority',()=>{
  const contract={rejectedRequestsMayUpdateSharedState:true};const system=behavior(true);system.request('known',10);assert.equal(system.request('unmapped',20),false);assert.equal(system.completeFirst(),20);
  const assessment=contract.rejectedRequestsMayUpdateSharedState?{semanticConclusion:'not-asserted-bug',reason:'Captured contract permits this side effect'}:{semanticConclusion:'unassessed'};
  assert.equal(assessment.semanticConclusion,'not-asserted-bug');
  const p=proof();assert.equal(p.contract.status,'navigation-only');assert.equal(p.contract.classification,undefined);
});
test('strict comparison still requires all three complete roles and fresh current receipt ownership',()=>{
  const missing=proof();missing.verdict.regression.oldEvidence=[0];assert.throws(missing.validate,/complete entry and baseline evidence/);
  const foreign=proof();foreign.verdict.evidence[0]={receiptId:'foreign-receipt'};assert.throws(foreign.validate,/Invalid evidence receipt/);
  const wrong=proof();wrong.verdict.regression.oldEvidence=[1,2];assert.throws(wrong.validate);
});
